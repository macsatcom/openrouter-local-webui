import express from 'express';
import { requireAuth } from '../auth.js';
import { queries, getSetting, getLoggingEnabled, checkUserSpendingLimit, recordSpending, getUserExposedModels, getOnlineModels } from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

async function fetchModels(apiKey) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
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
  return prompt + completion;
}

router.get('/models', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) {
    return res.json({ models: [], error: 'API key not configured' });
  }
  const allModels = await fetchModels(apiKey);
  const onlineModels = getOnlineModels();

  let filtered = allModels;
  if (!req.user.is_admin) {
    const userExposed = getUserExposedModels(req.user.id);
    if (userExposed.length === 0) {
      return res.json({ models: [] });
    }
    filtered = allModels.filter(m => userExposed.includes(m.id));
  }

  const sorted = filtered.sort((a, b) => getModelPrice(a) - getModelPrice(b));

  return res.json({
    models: sorted.map(m => {
      const promptPrice = m.pricing?.prompt ? formatPrice(m.pricing.prompt) : '?';
      const completionPrice = m.pricing?.completion ? formatPrice(m.pricing.completion) : '?';
      const isOnline = onlineModels.includes(m.id);
      const id = isOnline ? `${m.id}:online` : m.id;
      const displayName = `${m.name || m.id}${isOnline ? ' [online]' : ''} (${promptPrice} / ${completionPrice})`;
      return {
        id,
        name: displayName,
        base_id: m.id
      };
    })
  });
});

router.post('/chat', requireAuth, async (req, res) => {
  const apiKey = getSetting('openrouter_api_key');
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  const { model, messages, max_tokens, skill_id, conversation_id } = req.body;
  if (!model || !messages || !messages.length) {
    return res.status(400).json({ error: 'model and messages required' });
  }

  const limitCheck = checkUserSpendingLimit(req.user.id);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `Limit exceeded: ${limitCheck.reason}` });
  }

  let conversationId = conversation_id;
  let isNewConversation = false;

  if (conversationId) {
    const conv = queries.getConversationById.get(conversationId, req.user.id);
    if (!conv) {
      conversationId = null;
    }
  }

  if (!conversationId) {
    const firstUserMessage = messages.find(m => m.role === 'user');
    const autoTitle = firstUserMessage
      ? firstUserMessage.content.slice(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '')
      : 'New conversation';
    const result = queries.createConversation.run(req.user.id, autoTitle);
    conversationId = result.lastInsertRowid;
    isNewConversation = true;
  }

  const systemMessages = [];
  if (skill_id) {
    const skill = queries.getSkillById.get(skill_id);
    if (skill) {
      systemMessages.push({ role: 'system', content: skill.content });
    }
  }

  const fullMessages = [...systemMessages, ...messages];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let accumulatedCost = 0;
  let accumulatedTokens = 0;
  let fullResponse = '';

  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (lastUserMsg) {
    queries.createChatMessage.run(conversationId, 'user', lastUserMsg.content, model, null, null);
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Family Chat'
      },
      body: JSON.stringify({
        model,
        messages: fullMessages,
        max_tokens: max_tokens || 4096,
        stream: true
      })
    });

    if (!response.ok) {
      const error = await response.text();
      res.write(`data: ${JSON.stringify({ error: `OpenRouter error: ${error}` })}\n\n`);
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          if (getLoggingEnabled()) {
            const lastUserMsg = messages.filter(m => m.role === 'user').pop();
            if (lastUserMsg) {
              queries.logChat.run(req.user.id, model, lastUserMsg.content, fullResponse, accumulatedCost, accumulatedTokens);
            }
          }
          continue;
        }
        try {
          const chunk = JSON.parse(data);
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
          if (chunk.usage) {
            accumulatedCost = chunk.usage.cost || 0;
            accumulatedTokens = chunk.usage.total_tokens || 0;
          }
        } catch {}
      }
    }

    if (accumulatedCost > 0) {
      recordSpending(req.user.id, Math.round(accumulatedCost * 100));
    }

    queries.createChatMessage.run(conversationId, 'assistant', fullResponse, model, accumulatedCost, accumulatedTokens);
    queries.updateConversationTime.run(conversationId);

    res.write(`data: ${JSON.stringify({ done: true, conversation_id: conversationId, usage: { cost: accumulatedCost, tokens: accumulatedTokens } })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Chat error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

router.get('/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const logs = queries.getChatLogsByUser.all(req.user.id, limit, offset);
  res.json({ logs });
});

export default router;