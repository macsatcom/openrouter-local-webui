import express from 'express';
import { requireAuth } from '../auth.js';
import { queries, getSetting, checkUserSpendingLimit, recordSpending, getUserExposedModels, getMaxVideoResolution, getMaxVideoDuration } from '../db.js';
import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { generateVideoFilename, saveVideoFromBuffer, deleteVideoFile } from '../video-storage.js';
import path from 'path';
import fs from 'fs';
import VIDEOS_DIR from '../video-storage.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

async function fetchVideoModels(apiKey) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/videos/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch {
    return [];
  }
}

function formatVideoPrice(model) {
  const skus = model.pricing_skus || {};
  const prices = Object.values(skus).map(p => parseFloat(p)).filter(p => !isNaN(p));
  if (prices.length === 0) return '?';
  const minPrice = Math.min(...prices);
  if (minPrice === 0) return 'Free';
  if (minPrice < 0.001) return '$' + (minPrice * 1000).toFixed(3) + '/K per sec';
  return '$' + minPrice.toFixed(3) + '/s';
}

function compareResolutions(a, b) {
  const rank = { '480p': 1, '720p': 2, '1080p': 3, '1K': 3, '2K': 4, '4K': 5 };
  return (rank[a] || 0) - (rank[b] || 0);
}

router.get('/models', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) return res.json({ models: [], error: 'API key not configured' });

  const allModels = await fetchVideoModels(apiKey);
  let filtered = allModels;
  const userExposed = getUserExposedModels(req.user.id);
  if (userExposed.length > 0) {
    filtered = allModels.filter(m => userExposed.includes(m.id));
  }

  const maxRes = getMaxVideoResolution();
  if (maxRes) {
    filtered = filtered.filter(m => {
      const supported = m.supported_resolutions || [];
      return supported.some(r => compareResolutions(r, maxRes) <= 0);
    });
  }

  return res.json({
    models: filtered.map(m => ({
      id: m.id,
      name: `${m.name || m.id} (${formatVideoPrice(m)})`,
      supported_durations: m.supported_durations || [],
      supported_resolutions: m.supported_resolutions || [],
      supported_aspect_ratios: m.supported_aspect_ratios || [],
      supported_frame_images: m.supported_frame_images || []
    })),
    admin_limits: {
      max_resolution: maxRes || null,
      max_duration: getMaxVideoDuration() || null
    }
  });
});

router.post('/generate', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { model, prompt, duration, resolution, aspect_ratio, frame_images, input_references, generate_audio } = req.body;
  if (!model || !prompt) return res.status(400).json({ error: 'model and prompt required' });

  const limitCheck = checkUserSpendingLimit(req.user.id);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `Limit exceeded: ${limitCheck.reason}` });
  }

  const maxRes = getMaxVideoResolution();
  const maxDur = getMaxVideoDuration();
  const effectiveRes = resolution || '720p';
  const effectiveDur = duration || 5;

  if (maxRes && compareResolutions(effectiveRes, maxRes) > 0) {
    return res.status(400).json({ error: `Resolution ${effectiveRes} exceeds admin max of ${maxRes}` });
  }
  if (maxDur > 0 && effectiveDur > maxDur) {
    return res.status(400).json({ error: `Duration ${effectiveDur}s exceeds admin max of ${maxDur}s` });
  }

  try {
    const body = { model, prompt, duration: effectiveDur, resolution: effectiveRes };
    if (aspect_ratio) body.aspect_ratio = aspect_ratio;
    if (generate_audio !== undefined) body.generate_audio = generate_audio;
    if (frame_images) body.frame_images = frame_images;
    if (input_references) body.input_references = input_references;

    const response = await fetch('https://openrouter.ai/api/v1/videos', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
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
    const videoId = uuidv4();

    queries.logVideo.run(
      videoId, req.user.id, model, prompt,
      data.status || 'pending', data.id,
      effectiveDur, effectiveRes, aspect_ratio || null,
      generate_audio ? 1 : 0, 0, null
    );

    res.json({ id: videoId, job_id: data.id, status: data.status, polling_url: data.polling_url });
  } catch (error) {
    console.error('Video generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/list', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;

  let logs;
  if (status) {
    logs = db.prepare('SELECT * FROM video_logs WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(req.user.id, status, limit, offset);
  } else {
    logs = queries.getVideoLogsByUser.all(req.user.id, limit, offset);
  }

  res.json({
    logs: logs.map(l => ({
      ...l,
      video_url: l.video_path ? `/api/video/download/${l.id}` : null,
      prompt_short: (l.prompt || '').slice(0, 80)
    }))
  });
});

router.get('/download/:id', (req, res) => {
  const video = queries.getVideoById.get(req.params.id);
  if (!video || !video.video_path) return res.status(404).json({ error: 'Not found' });
  const filepath = path.join(VIDEOS_DIR, video.video_path);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filepath);
});

router.delete('/delete/:id', requireAuth, (req, res) => {
  const video = queries.getVideoById.get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  if (video.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (video.video_path) deleteVideoFile(video.video_path);
  db.prepare('DELETE FROM video_logs WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM video_notifications WHERE video_id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/jobs', requireAuth, (req, res) => {
  const ids = req.query.ids ? req.query.ids.split(',') : [];
  if (ids.length === 0) return res.json({ jobs: [] });
  const placeholders = ids.map(() => '?').join(',');
  const jobs = db.prepare(`SELECT id, status FROM video_logs WHERE id IN (${placeholders})`).all(...ids);
  res.json({ jobs });
});

router.get('/notifications', requireAuth, (req, res) => {
  const notifications = queries.getUnseenNotifications.all(req.user.id);
  res.json({
    count: notifications.length,
    videos: notifications.map(n => ({
      id: n.video_id,
      prompt_snippet: (n.prompt || '').slice(0, 60)
    }))
  });
});

router.post('/notifications/mark-seen', requireAuth, (req, res) => {
  const { video_id } = req.body;
  if (video_id) {
    queries.markVideoNotificationSeen.run(req.user.id, video_id);
  } else {
    queries.markNotificationsSeen.run(req.user.id);
  }
  res.json({ success: true });
});

export default router;
