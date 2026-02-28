import 'server-only';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { FunctionDefinition } from '@/lib/azure-openai/service';
import type { ToolExecutionResult } from '@/lib/agent/types';
import { buildMcpToolName, parseMcpToolName } from './naming';
import type { McpServerConfig } from './config';
import { hasFirecrawlToken } from './firecrawl';

type McpToolSpec = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpRuntimeServerConfig = McpServerConfig & {
  origin: 'env' | 'user';
  userServerId?: string;
};

export type McpRuntimeOptions = {
  timeoutMs?: number;
  maxResultChars?: number;
};

type McpClientEntry = {
  config: McpRuntimeServerConfig;
  client?: Client;
  connectPromise?: Promise<void>;
  tools?: McpToolSpec[];
};

type UnknownRecord = Record<string, unknown>;

const FIRECRAWL_SERVER_ID = 'firecrawl-mcp';

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function clipText(text: string, max: number): string {
  const raw = String(text ?? '');
  if (raw.length <= max) return raw;
  if (max <= 1) return raw.slice(0, max);
  return `${raw.slice(0, max - 1).trimEnd()}…`;
}

const FIRECRAWL_MAP_TOOL_NAMES = new Set(['firecrawl_map', 'map']);

function isFirecrawlMapTool(name: string): boolean {
  return FIRECRAWL_MAP_TOOL_NAMES.has(name.trim().toLowerCase());
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeFirecrawlMapUrl(raw: string): { key: string; url: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = (() => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    return `https://${trimmed}`;
  })();

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (!parsed.hostname) return null;
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!hostname) return null;

  const port = parsed.port;
  const isDefaultPort = (protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443');
  const portSuffix = port && !isDefaultPort ? `:${port}` : '';

  let pathname = parsed.pathname || '';
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname === '/' || pathname === '') {
    pathname = '';
  } else if (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  const key = `${hostname}${portSuffix}${pathname}`;
  const normalizedUrl = `${protocol}//${hostname}${portSuffix}${pathname}`;
  return { key, url: normalizedUrl };
}

function normalizeFirecrawlMapUrls(urls: string[]): { normalized: string[]; changed: boolean } {
  const normalized: string[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const raw of urls) {
    if (typeof raw !== 'string') {
      changed = true;
      continue;
    }
    const info = normalizeFirecrawlMapUrl(raw);
    if (!info) {
      changed = true;
      continue;
    }
    if (seen.has(info.key)) {
      changed = true;
      continue;
    }
    seen.add(info.key);
    normalized.push(info.url);
    if (info.url !== raw.trim()) changed = true;
  }

  return { normalized, changed };
}

function normalizeUrlArrayValue(raw: unknown): { normalized: string[]; changed: boolean } | null {
  if (!Array.isArray(raw)) return null;
  const urls = raw.filter((item): item is string => typeof item === 'string');
  if (urls.length === 0) return null;
  const { normalized, changed } = normalizeFirecrawlMapUrls(urls);
  if (!changed || normalized.length === 0) return null;
  return { normalized, changed };
}

function normalizeFirecrawlMapJson(value: unknown): { normalized: unknown; changed: boolean } | null {
  if (Array.isArray(value)) {
    const urls = value.filter((item): item is string => typeof item === 'string');
    if (urls.length === 0) return null;
    const { normalized, changed } = normalizeFirecrawlMapUrls(urls);
    if (!changed || normalized.length === 0) return null;
    return { normalized, changed: true };
  }
  if (!isRecord(value)) return null;

  for (const key of ['links', 'urls']) {
    const normalized = normalizeUrlArrayValue(value[key]);
    if (normalized) {
      return {
        normalized: { ...value, [key]: normalized.normalized },
        changed: true,
      };
    }
  }

  const data = isRecord(value.data) ? (value.data as UnknownRecord) : null;
  if (data) {
    for (const key of ['links', 'urls']) {
      const normalized = normalizeUrlArrayValue(data[key]);
      if (normalized) {
        return {
          normalized: { ...value, data: { ...data, [key]: normalized.normalized } },
          changed: true,
        };
      }
    }
  }

  return null;
}

function normalizeFirecrawlMapText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parsed = safeJsonParse(trimmed);
  if (parsed !== null) {
    const normalized = normalizeFirecrawlMapJson(parsed);
    if (!normalized) return null;
    try {
      return JSON.stringify(normalized.normalized, null, 2);
    } catch {
      return null;
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const cleaned = lines.map((line) => line.replace(/^[-*]\s+/, '').replace(/[,;]+$/, ''));
  const { normalized, changed } = normalizeFirecrawlMapUrls(cleaned);
  if (!changed || normalized.length === 0) return null;
  return normalized.join('\n');
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

/**
 * Extract plain-text content from an MCP SDK `callTool` result.
 *
 * The MCP protocol returns `{ content: [{ type: "text", text: "..." }, ...] }`.
 * We flatten this to a single string so the LLM sees clean output rather than
 * the verbose MCP envelope.  Non-text items (images, resources) are noted but
 * their binary payloads are elided.
 */
function extractMcpTextContent(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const itemType = typeof item.type === 'string' ? item.type : '';
    if (itemType === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (itemType === 'image') {
      parts.push('[image content omitted]');
    } else if (itemType === 'resource') {
      const uri = isRecord(item.resource) && typeof item.resource.uri === 'string' ? item.resource.uri : '';
      parts.push(uri ? `[resource: ${uri}]` : '[resource content omitted]');
    }
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function buildMcpToolErrorResult(
  config: McpRuntimeServerConfig,
  toolName: string,
  redactedArgs: UnknownRecord,
  error: { message: string; name?: string }
): ToolExecutionResult {
  const performedAt = new Date().toISOString();
  const errorPayload = error.name ? { name: error.name, message: error.message } : { message: error.message };
  const markdown = [
    '## MCP Tool Result',
    '',
    `**Server:** ${config.label} (\`${config.id}\`)`,
    `**Tool:** \`${toolName}\``,
    `**Performed at:** ${performedAt}`,
    '',
    '### Error',
    '',
    error.message,
  ].join('\n');
  const canvasData = {
    kind: 'mcp_tool_result_v1',
    performedAt,
    serverId: config.id,
    serverLabel: config.label,
    tool: toolName,
    ok: false,
    args: redactedArgs,
    error: errorPayload,
    markdown,
  };
  return {
    ok: false,
    error: errorPayload,
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

function mergeSignals(primary: AbortSignal, extra?: AbortSignal): AbortSignal {
  if (!extra) return primary;
  if (typeof (AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as typeof AbortSignal & { any: (signals: AbortSignal[]) => AbortSignal }).any([primary, extra]);
  }
  extra.addEventListener('abort', () => {
    try {
      primary.dispatchEvent(new Event('abort'));
    } catch {
      // ignore
    }
  });
  return primary;
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const signal = mergeSignals(controller.signal, init?.signal ?? undefined);
      return await fetch(input, { ...init, signal });
    } finally {
      clearTimeout(timeout);
    }
  };
}

export class McpRuntime {
  private clients = new Map<string, McpClientEntry>();
  private servers: McpRuntimeServerConfig[];
  private timeoutMs: number;
  private maxResultChars: number;
  private cachedDefinitions: FunctionDefinition[] | null = null;

  constructor(servers: McpRuntimeServerConfig[], opts?: McpRuntimeOptions) {
    this.servers = servers;
    this.timeoutMs = opts?.timeoutMs ?? 20_000;
    this.maxResultChars = opts?.maxResultChars ?? 12_000;
  }

  public getServer(serverId: string): McpRuntimeServerConfig | undefined {
    return this.servers.find((server) => server.id === serverId);
  }

  public async listToolDefinitions(): Promise<FunctionDefinition[]> {
    if (this.cachedDefinitions) return this.cachedDefinitions;
    if (this.servers.length === 0) return [];
    const definitions: FunctionDefinition[] = [];
    for (const config of this.servers) {
      const serverTools = await this.listToolsForServer(config).catch((error) => {
        console.error(`MCP server '${config.id}' failed to list tools.`, error);
        return [];
      });
      for (const spec of serverTools) {
        const toolName = buildMcpToolName(config.id, spec.name);
        definitions.push({
          name: toolName,
          description: spec.description?.trim()
            ? `${config.label}: ${spec.description.trim()}`
            : `MCP tool from ${config.label}.`,
          parameters: toToolParameters(spec.inputSchema),
        });
      }
    }
    this.cachedDefinitions = definitions;
    return definitions;
  }

  public async callToolByQualifiedName(toolName: string, args: unknown): Promise<ToolExecutionResult> {
    const parsed = parseMcpToolName(toolName);
    if (!parsed) {
      return { ok: false, error: { message: `Invalid MCP tool name: ${toolName}` } };
    }
    const server = this.getServer(parsed.serverId);
    if (!server) {
      return { ok: false, error: { message: `MCP server not found: ${parsed.serverId}` } };
    }
    return this.callTool(server, parsed.toolName, args);
  }

  private async listToolsForServer(config: McpRuntimeServerConfig): Promise<McpToolSpec[]> {
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
    config: McpRuntimeServerConfig,
    toolName: string,
    args: unknown
  ): Promise<ToolExecutionResult> {
    const safeArgs = isRecord(args) ? args : {};
    const redactedArgs = redactSensitive(safeArgs) as UnknownRecord;
    if (config.id === FIRECRAWL_SERVER_ID && config.transport === 'stdio' && !hasFirecrawlToken(config)) {
      return buildMcpToolErrorResult(config, toolName, redactedArgs, {
        name: 'ConfigurationError',
        message:
          'Firecrawl API key is not configured. Set FIRECRAWL_API_KEY on the server or add a Firecrawl token in Integrations.',
      });
    }
    const entry = await this.ensureConnected(config);
    if (!entry.client) {
      return {
        ok: false,
        error: { message: `MCP server unavailable: ${config.id}` },
      };
    }
    try {
      const result = await entry.client.callTool({ name: toolName, arguments: safeArgs });
      const performedAt = new Date().toISOString();
      const safeResult = redactSensitive(result);

      // Extract human-readable text from the MCP content envelope so the LLM
      // receives clean output instead of the verbose `{content:[{type,text}]}`
      // structure.  Fall back to the full JSON serialisation if extraction fails.
      let extractedText = extractMcpTextContent(safeResult);
      if (extractedText && config.id === FIRECRAWL_SERVER_ID && isFirecrawlMapTool(toolName)) {
        const normalized = normalizeFirecrawlMapText(extractedText);
        if (normalized) extractedText = normalized;
      }
      let resultJson = '';
      try {
        resultJson = extractedText ?? JSON.stringify(safeResult, null, 2);
      } catch {
        resultJson = extractedText ?? String(safeResult);
      }
      const clippedJson = clipText(resultJson, this.maxResultChars);
      const safeResultForMemory =
        resultJson.length > this.maxResultChars
          ? { truncated: true, preview: clippedJson }
          : (extractedText != null ? extractedText : safeResult);
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
        clippedJson,
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
        result: safeResultForMemory,
        markdown,
      };

      if (!ok) {
        return {
          ok: false,
          error: { message: `MCP tool error: ${config.id}.${toolName}` },
          data: safeResultForMemory,
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
        data: safeResultForMemory,
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
      // If the error looks like a transport/connection failure, invalidate the
      // cached client so the next call triggers a fresh connection attempt.
      if (this.isTransportError(error)) {
        console.warn(`[McpRuntime] Transport error for '${config.id}'; invalidating connection for retry.`);
        this.clients.delete(config.id);
      }

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

  /**
   * Detect transport-level errors that indicate the connection is broken and should
   * be re-established on the next call.
   */
  private isTransportError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('econnreset') || lower.includes('econnrefused')) return true;
    if (lower.includes('socket') && (lower.includes('hang up') || lower.includes('closed'))) return true;
    if (lower.includes('connection closed') || lower.includes('connection reset')) return true;
    if (lower.includes('transport') && lower.includes('error')) return true;
    if (lower.includes('broken pipe') || lower.includes('epipe')) return true;
    if (lower.includes('channel closed') || lower.includes('process exited')) return true;
    const code = (() => {
      if (!err || typeof err !== 'object') return undefined;
      const record = err as { code?: unknown };
      return typeof record.code === 'string' ? record.code : undefined;
    })();
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') return true;
    return false;
  }

  private async ensureConnected(config: McpClientEntry['config']): Promise<McpClientEntry> {
    const existing = this.clients.get(config.id);
    if (existing) {
      if (existing.connectPromise) {
        await existing.connectPromise;
      }
      // If a previous connection attempt failed (client is undefined), retry.
      if (existing.client) return existing;
      console.warn(`[McpRuntime] Retrying connection to '${config.id}' (previous attempt failed).`);
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
            fetch: createTimeoutFetch(this.timeoutMs),
          });
    const client = new Client({ name: 'tuna-mcp', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    entry.client = client;
  }
}
