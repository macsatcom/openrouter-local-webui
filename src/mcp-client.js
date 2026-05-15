import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

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

export async function connectToMcpServers(serverConfigs) {
  const clients = [];

  for (const server of serverConfigs) {
    const prefix = sanitizePrefix(server.name) + '_';
    try {
      const client = new Client({
        name: 'openrouter-webui',
        version: '1.0.0'
      });

      let transport;
      if (server.transport_type === 'sse') {
        transport = new SSEClientTransport(new URL(server.url));
      } else {
        transport = new StdioClientTransport({
          command: server.command,
          args: parseArgs(server.args),
          env: parseEnv(server.env)
        });
      }

      await client.connect(transport);
      clients.push({ client, transport, prefix, name: server.name });
    } catch (err) {
      console.error(`MCP: Failed to connect to "${server.name}":`, err.message);
    }
  }

  return clients;
}

export async function listToolsFromClients(clients) {
  const allTools = [];
  const toolMap = {};

  for (const entry of clients) {
    try {
      const result = await entry.client.listTools();
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
    const result = await entry.client.callTool({
      name: entry.originalName,
      arguments: args
    });

    const content = result.content || [];
    const textParts = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    return { result: textParts || JSON.stringify(result) };
  } catch (err) {
    return { error: err.message };
  }
}

export async function disconnectMcpClients(clients) {
  for (const entry of clients) {
    try {
      await entry.client.close();
    } catch (err) {
      console.error(`MCP: Error disconnecting "${entry.name}":`, err.message);
    }
  }
}
