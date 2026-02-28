import 'server-only';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { FunctionDefinition } from '@/lib/azure-openai/service';
import type { Tool, ToolExecutionResult } from '@/lib/agent/types';
import { buildMcpToolName } from './naming';
import { getMcpServerConfigs, getMcpServerSummaries, type McpServerConfig, type McpServerSummary } from './config';

type McpToolSpec = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type McpClientEntry = {
  config: McpServerConfig;
  client?: Client;
  connectPromise?: Promise<void>;
  tools?: McpToolSpec[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function clipText(text: string, max = 12000): string {
  const raw = String(text ?? '');
  if (raw.length <= max) return raw;
  if (max <= 1) return raw.slice(0, max);
  return `${raw.slice(0, max - 1).trimEnd()}…`;
}

const SENSITIVE_KEY_RE = /(token|secret|password|api[_-]?key|authorization|cookie)/i;
function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: UnknownRecord = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : redactSensitive(val, depth + 1);
  }
  return out;
}

function toToolParameters(schema: unknown): FunctionDefinition['parameters'] {
  if (!isRecord(schema)) {
    return { type: 'object', properties: {} };
  }
  const properties = isRecord(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  return required && required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

function normalizeToolSpec(value: unknown): McpToolSpec | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const description = typeof value.description === 'string' ? value.description.trim() : undefined;
  return {
    name,
    description,
    inputSchema: 'inputSchema' in value ? value.inputSchema : undefined,
  };
}

function safeErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? `${fallback} (${name})` : fallback;
}

export class McpManager {
  private clients = new Map<string, McpClientEntry>();

  public listServerSummaries(): McpServerSummary[] {
    return getMcpServerSummaries();
  }

  public async listMcpTools(): Promise<Tool[]> {
    const configs = getMcpServerConfigs();
    if (configs.length === 0) return [];
    const tools: Tool[] = [];
    for (const config of configs) {
      const serverTools = await this.listToolsForServer(config).catch((error) => {
        console.error(`MCP server '${config.id}' failed to list tools.`, error);
        return [];
      });
      for (const spec of serverTools) {
        const toolName = buildMcpToolName(config.id, spec.name);
        const definition: FunctionDefinition = {
          name: toolName,
          description: spec.description?.trim()
            ? `${config.label}: ${spec.description.trim()}`
            : `MCP tool from ${config.label}.`,
          parameters: toToolParameters(spec.inputSchema),
        };
        tools.push({
          category: 'data',
          definition,
          handler: async (args: unknown): Promise<ToolExecutionResult> => {
            return this.callTool(config, spec.name, args);
          },
        });
      }
    }
    return tools;
  }

  private async listToolsForServer(config: McpServerConfig): Promise<McpToolSpec[]> {
    const entry = await this.ensureConnected(config);
    if (!entry.client) return [];
    if (entry.tools) return entry.tools;
    const response = await entry.client.listTools();
    const toolsRaw = isRecord(response) && Array.isArray(response.tools) ? response.tools : [];
    const tools = toolsRaw.map(normalizeToolSpec).filter((t): t is McpToolSpec => Boolean(t));
    entry.tools = tools;
    return tools;
  }

  private async callTool(
    config: McpServerConfig,
    toolName: string,
    args: unknown
  ): Promise<ToolExecutionResult> {
    const entry = await this.ensureConnected(config);
    if (!entry.client) {
      return {
        ok: false,
        error: { message: `MCP server unavailable: ${config.id}` },
      };
    }
    const safeArgs = isRecord(args) ? args : {};
    const redactedArgs = redactSensitive(safeArgs);
    try {
      const result = await entry.client.callTool({ name: toolName, arguments: safeArgs });
      const performedAt = new Date().toISOString();
      const safeResult = redactSensitive(result);
      let resultJson = '';
      try {
        resultJson = JSON.stringify(safeResult, null, 2);
      } catch {
        resultJson = String(safeResult);
      }
      const ok = !(isRecord(result) && result.isError === true);
      const markdown = [
        '## MCP Tool Result',
        '',
        `**Server:** ${config.label} (\`${config.id}\`)`,
        `**Tool:** \`${toolName}\``,
        `**Performed at:** ${performedAt}`,
        '',
        ok ? '### Result' : '### Error',
        '',
        '```json',
        clipText(resultJson, 12000),
        '```',
      ].join('\n');

      const canvasData = {
        kind: 'mcp_tool_result_v1',
        performedAt,
        serverId: config.id,
        serverLabel: config.label,
        tool: toolName,
        ok,
        args: redactedArgs,
        result: safeResult,
        markdown,
      };

      if (!ok) {
        return {
          ok: false,
          error: { message: `MCP tool error: ${config.id}.${toolName}` },
          data: safeResult,
          sideEffects: [
            {
              type: 'ui.upsertArtifact',
              payload: {
                id: 'connectors',
                type: 'markdown',
                title: 'Connectors',
                content: canvasData,
                status: 'final',
                isCollaborative: true,
              },
            },
            { type: 'ui.openArtifact', payload: { id: 'connectors', type: 'markdown' } },
          ],
        };
      }

      return {
        ok: true,
        data: safeResult,
        sideEffects: [
          {
            type: 'ui.upsertArtifact',
            payload: {
              id: 'connectors',
              type: 'markdown',
              title: 'Connectors',
              content: canvasData,
              status: 'final',
              isCollaborative: true,
            },
          },
          { type: 'ui.openArtifact', payload: { id: 'connectors', type: 'markdown' } },
        ],
      };
    } catch (error) {
      const performedAt = new Date().toISOString();
      const message = safeErrorMessage(error, `MCP tool failed: ${config.id}.${toolName}`);
      const markdown = [
        '## MCP Tool Result',
        '',
        `**Server:** ${config.label} (\`${config.id}\`)`,
        `**Tool:** \`${toolName}\``,
        `**Performed at:** ${performedAt}`,
        '',
        '### Error',
        '',
        message,
      ].join('\n');
      const canvasData = {
        kind: 'mcp_tool_result_v1',
        performedAt,
        serverId: config.id,
        serverLabel: config.label,
        tool: toolName,
        ok: false,
        args: redactedArgs,
        error: { message },
        markdown,
      };
      return {
        ok: false,
        error: { message },
        sideEffects: [
          {
            type: 'ui.upsertArtifact',
            payload: {
              id: 'connectors',
              type: 'markdown',
              title: 'Connectors',
              content: canvasData,
              status: 'final',
              isCollaborative: true,
            },
          },
          { type: 'ui.openArtifact', payload: { id: 'connectors', type: 'markdown' } },
        ],
      };
    }
  }

  private async ensureConnected(config: McpServerConfig): Promise<McpClientEntry> {
    const existing = this.clients.get(config.id);
    if (existing) {
      if (existing.connectPromise) {
        await existing.connectPromise;
      }
      // If a previous connection attempt failed (client is undefined), retry.
      if (existing.client) return existing;
      console.warn(`[McpManager] Retrying connection to '${config.id}' (previous attempt failed).`);
      this.clients.delete(config.id);
    }

    const entry: McpClientEntry = { config };
    entry.connectPromise = this.connectEntry(entry).catch((error) => {
      console.error(`MCP server '${config.id}' failed to connect.`, error);
    });
    this.clients.set(config.id, entry);
    if (entry.connectPromise) {
      await entry.connectPromise;
    }
    return entry;
  }

  private async connectEntry(entry: McpClientEntry): Promise<void> {
    const transport =
      entry.config.transport === 'stdio'
        ? new StdioClientTransport({
            command: entry.config.command,
            args: entry.config.args,
            env: entry.config.env,
          })
        : new StreamableHTTPClientTransport(new URL(entry.config.url), {
            requestInit: { headers: entry.config.headers },
          });
    const client = new Client({ name: 'tuna-mcp', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    entry.client = client;
  }
}

export const mcpManager = new McpManager();
