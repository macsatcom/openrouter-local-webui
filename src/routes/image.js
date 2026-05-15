import express from 'express';
import { requireAuth } from '../auth.js';
import { queries, getSetting, getLoggingEnabled, checkUserSpendingLimit, recordSpending, getUserExposedModels } from '../db.js';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, '..', '..', 'generated-images');

if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

const router = express.Router();

async function fetchImageModels(apiKey) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models?output_modalities=image', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch {
    return [];
  }
}

function formatPrice(price) {
  const p = parseFloat(price);
  if (p === 0) return 'Free';
  if (p < 0.00001) return '$' + (p * 1000000).toFixed(2) + '/M';
  if (p < 0.0001) return '$' + (p * 1000000).toFixed(1) + '/M';
  if (p < 0.001) return '$' + (p * 1000).toFixed(2) + '/K';
  return '$' + p.toFixed(3);
}

function getModelPrice(m) {
  const prompt = parseFloat(m.pricing?.prompt) || 0;
  const completion = parseFloat(m.pricing?.completion) || 0;
  const image = parseFloat(m.pricing?.image) || 0;
  return prompt + completion + image;
}

router.get('/models', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) {
    return res.json({ models: [], error: 'API key not configured' });
  }
  const allModels = await fetchImageModels(apiKey);

  let filtered = allModels;
  const userExposed = getUserExposedModels(req.user.id);
  if (userExposed.length > 0) {
    filtered = allModels.filter(m => userExposed.includes(m.id));
  }

  const sorted = filtered.sort((a, b) => getModelPrice(a) - getModelPrice(b));

  return res.json({
    models: sorted.map(m => {
      const imagePrice = m.pricing?.image ? formatPrice(m.pricing.image) : (m.pricing?.prompt ? formatPrice(m.pricing.prompt) : '?');
      return {
        id: m.id,
        name: `${m.name || m.id} (${imagePrice})`
      };
    })
  });
});

router.post('/generate', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  const { model, prompt, aspect_ratio, size, quality, output_format, background, input_fidelity, reference_image, edit_mode } = req.body;
  if (!model || !prompt) {
    return res.status(400).json({ error: 'model and prompt required' });
  }

  const limitCheck = checkUserSpendingLimit(req.user.id);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `Limit exceeded: ${limitCheck.reason}` });
  }

  try {
    let userContent = prompt;
    let imageConfig = {};

    if (reference_image && edit_mode) {
      userContent = [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: reference_image.startsWith('data:') ? reference_image : `data:image/png;base64,${reference_image}` }
        }
      ];
      imageConfig.input_image_mask = {
        image_url: reference_image.startsWith('data:') ? reference_image : `data:image/png;base64,${reference_image}`
      };
      if (input_fidelity) imageConfig.input_fidelity = input_fidelity;
    }
    if (aspect_ratio && aspect_ratio !== 'auto') imageConfig.aspect_ratio = aspect_ratio;
    if (size && size !== 'auto') imageConfig.image_size = size;
    if (quality && quality !== 'auto') imageConfig.quality = quality;
    if (output_format && output_format !== 'auto') imageConfig.output_format = output_format;
    if (background && background !== 'auto') imageConfig.background = background;

    if (Object.keys(imageConfig).length > 0) {
      body.image_config = imageConfig;
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'OpenRouter Local WebUI'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `OpenRouter error: ${errorText}`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) errorMsg = errorJson.error.message;
      } catch {}
      return res.status(400).json({ error: errorMsg });
    }

    const data = await response.json();
    console.log('IMAGE GEN RESPONSE:', JSON.stringify(data).slice(0, 2000));

    const usage = data.usage || {};
    const message = data.choices?.[0]?.message;
    const content = message?.content;

    let imageUrl = null;

    if (message?.images?.length) {
      const img = message.images[0];
      imageUrl = img.image_url?.url || img.url || img;
      if (typeof imageUrl === 'object' && imageUrl.url) imageUrl = imageUrl.url;
      console.log('Found image in message.images:', imageUrl);
    }

    if (!imageUrl && message?.content && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'image_url' || part.type === 'image') {
          imageUrl = part.image_url?.url || part.url || part.data || part;
          if (typeof imageUrl === 'object' && imageUrl.url) imageUrl = imageUrl.url;
          console.log('Found image in content array:', imageUrl);
          break;
        }
      }
    }

    if (!imageUrl && typeof content === 'string') {
      const urlMatch = content.match(/https?:\/\/[^\s\)\]]+\.(?:png|jpg|jpeg|gif|webp)/i);
      if (urlMatch) {
        imageUrl = urlMatch[0];
        console.log('Found image URL in text content:', imageUrl);
      }

      const base64Match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
      if (base64Match && !imageUrl) {
        const base64Data = base64Match[0];
        const mimeType = base64Data.split(';')[0].split(':')[1];
        const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
        const filename = `${uuidv4()}.${ext}`;
        const filepath = path.join(IMAGES_DIR, filename);
        const base64Content = base64Data.split(',')[1];
        fs.writeFileSync(filepath, Buffer.from(base64Content, 'base64'));
        imageUrl = `/api/image/download/${filename}`;
        console.log('Found base64 image, saved to:', filename);
      }
    }

    if (!imageUrl) {
      console.log('No image found in response. Message:', JSON.stringify(message).slice(0, 1000));
      return res.status(500).json({ error: 'No image in response. Check server logs for details.' });
    }

    if (imageUrl.startsWith('data:image/')) {
      const match = imageUrl.match(/data:image\/([^;]+);base64,(.+)/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const filename = `${uuidv4()}.${ext}`;
        const filepath = path.join(IMAGES_DIR, filename);
        fs.writeFileSync(filepath, Buffer.from(match[2], 'base64'));
        imageUrl = `/api/image/download/${filename}`;
        console.log('Saved base64 from message.images to:', filename);
      }
    }

    if (imageUrl && imageUrl.startsWith('http')) {
      try {
        const imageResponse = await fetch(imageUrl);
        if (imageResponse.ok) {
          const contentType = imageResponse.headers.get('content-type') || '';
          const isImage = contentType.startsWith('image/');
          const ext = isImage ? (contentType.split('/')[1] || 'png') : (imageUrl.split('.').pop().split('?')[0] || 'png');
          const filename = `${uuidv4()}.${ext}`;
          const filepath = path.join(IMAGES_DIR, filename);
          const buffer = await imageResponse.arrayBuffer();
          fs.writeFileSync(filepath, Buffer.from(buffer));
          imageUrl = `/api/image/download/${filename}`;
        }
      } catch (e) {
        console.error('Failed to download image:', e);
      }
    }

    const cost = usage.cost || 0;
    if (cost) {
      recordSpending(req.user.id, Math.round(cost * 100));
    }

    const localPath = imageUrl ? imageUrl.split('/').pop() : null;
    queries.logImage.run(req.user.id, model, prompt, localPath, cost);

    res.json({
      image_url: imageUrl,
      text: imageUrl,
      cost: cost,
      prompt
    });
  } catch (error) {
    console.error('Image generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/list', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const logs = queries.getImageLogsByUser.all(req.user.id, limit, offset);
  res.json({ logs: logs.map(l => ({ ...l, image_url: l.image_path ? `/api/image/download/${l.image_path}` : null })) });
});

router.get('/download/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9.-]/g, '');
  const filepath = path.join(IMAGES_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(filepath);
});

router.delete('/delete/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9.-]/g, '');
  const filepath = path.join(IMAGES_DIR, filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }
  res.json({ success: true });
});

export default router;