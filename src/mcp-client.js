import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'child_process';

function sanitizePrefix(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parseArgs(argsJson) {
  if (!argsJson) return [];
  try {
    const parsed = JSON.parse(argsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseEnv(envJson) {
  if (!envJson) return undefined;
  try {
    const parsed = JSON.parse(envJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function createTransport(server) {
  if (server.transport_type === 'sse') {
    const opts = {};
    if (server.auth_token) {
      opts.requestInit = { headers: { Authorization: `Bearer ${server.auth_token}` } };
    }
    return new SSEClientTransport(new URL(server.url), opts);
  }
  if (server.transport_type === 'streamable-http') {
    const opts = {};
    if (server.auth_token) {
      opts.requestInit = { headers: { Authorization: `Bearer ${server.auth_token}` } };
    }
    return new StreamableHTTPClientTransport(new URL(server.url), opts);
  }
  return new StdioClientTransport({
    command: server.command,
    args: parseArgs(server.args),
    env: parseEnv(server.env)
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' timed out after ' + (ms / 1000) + 's')), ms)
    )
  ]);
}

const MCP_CONNECT_TIMEOUT = 15000;
const MCP_TOOL_TIMEOUT = 30000;
const MAX_TOOL_RESULT_CHARS = 8000;
const MCP_IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Module-level connection cache: serverId -> { client, transport, prefix, name, configHash, lastUsed, idleTimer }
const mcpCache = new Map();

function configHashForServer(server) {
  return [
    server.id,
    server.updated_at || '',
    server.transport_type,
    server.command || '',
    server.args || '',
    server.url || '',
    server.auth_token || '',
    server.env || '',
    server.enabled
  ].join('|');
}

function scheduleIdleTeardown(serverId) {
  const entry = mcpCache.get(serverId);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = mcpCache.get(serverId);
    if (!current) return;
    if (Date.now() - current.lastUsed < MCP_IDLE_TIMEOUT) {
      scheduleIdleTeardown(serverId);
      return;
    }
    mcpCache.delete(serverId);
    current.client.close().catch(err => {
      console.error(`MCP: Error closing idle client "${current.name}":`, err.message);
    });
    console.log(`MCP: Closed idle client "${current.name}" after ${MCP_IDLE_TIMEOUT / 60000} min`);
  }, MCP_IDLE_TIMEOUT);
}

export function invalidateMcpServer(serverId) {
  const entry = mcpCache.get(serverId);
  if (!entry) return;
  mcpCache.delete(serverId);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.client.close().catch(err => {
    console.error(`MCP: Error invalidating client "${entry.name}":`, err.message);
  });
  console.log(`MCP: Invalidated cached client "${entry.name}"`);
}

async function connectSingleServer(server) {
  const prefix = sanitizePrefix(server.name) + '_';
  const client = new Client({
    name: 'openrouter-webui',
    version: '1.0.0'
  });
  const transport = createTransport(server);
  await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT, 'MCP connect ' + server.name);
  return { client, transport, prefix, name: server.name };
}

export async function connectToMcpServers(serverConfigs) {
  const clients = [];
  const failures = [];

  for (const server of serverConfigs) {
    const hash = configHashForServer(server);
    const cached = mcpCache.get(server.id);

    if (cached && cached.configHash === hash) {
      cached.lastUsed = Date.now();
      scheduleIdleTeardown(server.id);
      clients.push({
        client: cached.client,
        transport: cached.transport,
        prefix: cached.prefix,
        name: cached.name,
        _cached: true
      });
      continue;
    }

    if (cached && cached.configHash !== hash) {
      invalidateMcpServer(server.id);
    }

    try {
      const entry = await connectSingleServer(server);
      const cacheEntry = {
        ...entry,
        configHash: hash,
        lastUsed: Date.now(),
        idleTimer: null
      };
      mcpCache.set(server.id, cacheEntry);
      scheduleIdleTeardown(server.id);
      clients.push({
        client: entry.client,
        transport: entry.transport,
        prefix: entry.prefix,
        name: entry.name,
        _cached: false
      });
    } catch (err) {
      console.error(`MCP: Failed to connect to "${server.name}":`, err.message);
      failures.push({
        serverId: server.id,
        name: server.name,
        reason: err.message || String(err)
      });
    }
  }

  return { clients, failures };
}

export async function listToolsFromClients(clients) {
  const allTools = [];
  const toolMap = {};

  for (const entry of clients) {
    try {
      const result = await withTimeout(entry.client.listTools(), MCP_CONNECT_TIMEOUT, 'MCP listTools ' + entry.name);
      for (const tool of result.tools) {
        const prefixedName = entry.prefix + tool.name;
        toolMap[prefixedName] = { client: entry.client, transport: entry.transport, originalName: tool.name };
        allTools.push({
          type: 'function',
          function: {
            name: prefixedName,
            description: `[${entry.name}] ${tool.description || ''}`,
            parameters: tool.inputSchema || { type: 'object', properties: {} }
          }
        });
      }
    } catch (err) {
      console.error(`MCP: Failed to list tools for "${entry.name}":`, err.message);
    }
  }

  return { tools: allTools, toolMap };
}

export async function callMcpTool(toolMap, prefixedName, args) {
  const entry = toolMap[prefixedName];
  if (!entry) {
    return { error: `Tool "${prefixedName}" not found` };
  }

  try {
    const result = await withTimeout(
      entry.client.callTool({ name: entry.originalName, arguments: args }),
      MCP_TOOL_TIMEOUT,
      'MCP tool ' + prefixedName
    );

    const content = result.content || [];
    const textParts = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    let output = textParts || JSON.stringify(result);
    if (output.length > MAX_TOOL_RESULT_CHARS) {
      output = output.slice(0, MAX_TOOL_RESULT_CHARS) + '\n... [truncated ' + (output.length - MAX_TOOL_RESULT_CHARS) + ' chars]';
    }

    return { result: output };
  } catch (err) {
    return { error: err.message };
  }
}

export async function warmMcpCaches(serverConfigs) {
  console.log(`MCP: Warming caches for ${serverConfigs.length} enabled server(s)...`);
  const promises = serverConfigs.map(server => {
    return new Promise(resolve => {
      if (server.transport_type === 'sse' || server.transport_type === 'streamable-http') {
        console.log(`MCP: Skipping warm for remote server "${server.name}"`);
        resolve();
        return;
      }
      const args = parseArgs(server.args);
      const cmdArgs = [...args, '--version'];
      const child = spawn(server.command, cmdArgs, {
        env: { ...process.env, ...(parseEnv(server.env) || {}) },
        stdio: 'ignore'
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 30000);
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          console.log(`MCP: Warmed "${server.name}" (${server.command} ${args.join(' ')})`);
        } else {
          console.warn(`MCP: Warm for "${server.name}" exited with code ${code} (may be harmless)`);
        }
        resolve();
      });
      child.on('error', err => {
        clearTimeout(timer);
        console.warn(`MCP: Warm for "${server.name}" failed: ${err.message}`);
        resolve();
      });
    });
  });
  await Promise.all(promises);
  console.log('MCP: Cache warm completed');
}

export async function disconnectMcpClients(clients) {
  for (const entry of clients) {
    if (entry._cached) continue; // Cached clients are managed by idle timer
    try {
      await entry.client.close();
    } catch (err) {
      console.error(`MCP: Error disconnecting "${entry.name}":`, err.message);
    }
  }
}
