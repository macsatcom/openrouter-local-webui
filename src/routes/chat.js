import express from 'express';
import { requireAuth } from '../auth.js';
import { queries, getSetting, getLoggingEnabled, checkUserSpendingLimit, recordSpending, getUserExposedModels, getOnlineModels } from '../db.js';
import { connectToMcpServers, listToolsFromClients, callMcpTool, disconnectMcpClients } from '../mcp-client.js';
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
  const userExposed = getUserExposedModels(req.user.id);
  if (userExposed.length > 0) {
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
  const { model, messages, max_tokens, skill_id, conversation_id, mcp_server_ids } = req.body;
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
    let autoTitle = 'New conversation';
    if (firstUserMessage) {
      const textContent = typeof firstUserMessage.content === 'string'
        ? firstUserMessage.content
        : firstUserMessage.content.find(p => p.type === 'text')?.text || 'Image message';
      autoTitle = textContent.slice(0, 50) + (textContent.length > 50 ? '...' : '');
    }
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let accumulatedCost = 0;
  let accumulatedTokens = 0;
  let fullResponse = '';

  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (lastUserMsg) {
    const content = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content);
    queries.createChatMessage.run(conversationId, 'user', content, model, null, null);
  }

  let mcpClients = null;
  let mcpTools = null;
  let toolMap = null;

  if (mcp_server_ids && mcp_server_ids.length > 0) {
    const serverConfigs = mcp_server_ids
      .map(id => queries.getMcpServerById.get(parseInt(id)))
      .filter(Boolean)
      .filter(s => s.enabled);

    if (serverConfigs.length > 0) {
      mcpClients = await connectToMcpServers(serverConfigs);
      const result = await listToolsFromClients(mcpClients);
      mcpTools = result.tools;
      toolMap = result.toolMap;
    }
  }

  try {
    let currentMessages = [...systemMessages, ...messages];
    let toolsToSend = mcpTools && mcpTools.length > 0 ? mcpTools : undefined;
    let maxRounds = 5;

    while (maxRounds-- > 0) {
      const body = {
        model,
        messages: currentMessages,
        max_tokens: max_tokens || 4096,
        stream: true
      };
      if (toolsToSend) {
        body.tools = toolsToSend;
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
        const error = await response.text();
        res.write(`data: ${JSON.stringify({ error: `OpenRouter error: ${error}` })}\n\n`);
        res.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let roundContent = '';
      let roundCost = 0;
      let roundTokens = 0;
      let toolCallsAccumulator = {};
      let finishReason = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              roundContent += delta.content;
              fullResponse += delta.content;
              res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsAccumulator[idx]) {
                  toolCallsAccumulator[idx] = { id: '', name: '', arguments: '' };
                }
                if (tc.id) toolCallsAccumulator[idx].id = tc.id;
                if (tc.function?.name) toolCallsAccumulator[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallsAccumulator[idx].arguments += tc.function.arguments;
              }
            }
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            if (chunk.usage) {
              roundCost = chunk.usage.cost || 0;
              roundTokens = chunk.usage.total_tokens || 0;
            }
          } catch {
          }
        }
      }

      accumulatedCost += roundCost;
      accumulatedTokens += roundTokens;

      if (finishReason === 'tool_calls' && toolMap && Object.keys(toolCallsAccumulator).length > 0) {
        const sortedToolCalls = Object.keys(toolCallsAccumulator)
          .sort((a, b) => parseInt(a) - parseInt(b))
          .map(k => toolCallsAccumulator[k])
          .filter(tc => tc.name);

        const assistantToolCallMsg = {
          role: 'assistant',
          content: roundContent || null,
          tool_calls: sortedToolCalls.map(tc => ({
            id: tc.id || `call_${Date.now()}`,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments || '{}'
            }
          }))
        };
        currentMessages.push(assistantToolCallMsg);

        for (const tc of sortedToolCalls) {
          if (!tc.name) continue;
          res.write(`data: ${JSON.stringify({ tool_call: { name: tc.name } })}\n\n`);

          let args = {};
          try {
            args = JSON.parse(tc.arguments || '{}');
          } catch {
          }

          const toolResult = await callMcpTool(toolMap, tc.name, args);

          res.write(`data: ${JSON.stringify({
            tool_result: {
              name: tc.name,
              error: toolResult.error || null
            }
          })}\n\n`);

          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id || `call_${Date.now()}`,
            content: toolResult.error ? `Error: ${toolResult.error}` : (toolResult.result || 'Done')
          });
        }

        toolsToSend = undefined;
        continue;
      }

      if (finishReason === 'stop' || finishReason === null || finishReason === undefined) {
        break;
      }
      if (!toolMap) break;

      break;
    }
  } catch (error) {
    console.error('Chat error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
    return;
  } finally {
    if (mcpClients) {
      await disconnectMcpClients(mcpClients);
    }
  }

  if (accumulatedCost > 0) {
    recordSpending(req.user.id, Math.round(accumulatedCost * 100));
  }

  if (getLoggingEnabled()) {
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
      const logContent = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content);
      queries.logChat.run(req.user.id, model, logContent, fullResponse, accumulatedCost, accumulatedTokens);
    }
  }

  queries.createChatMessage.run(conversationId, 'assistant', fullResponse, model, accumulatedCost, accumulatedTokens);
  queries.updateConversationTime.run(conversationId);

  res.write(`data: ${JSON.stringify({ done: true, conversation_id: conversationId, usage: { cost: accumulatedCost, tokens: accumulatedTokens } })}\n\n`);
  res.end();
});

router.get('/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;
  const logs = queries.getChatLogsByUser.all(req.user.id, limit, offset);
  res.json({ logs });
});

export default router;
