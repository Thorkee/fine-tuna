import 'server-only';

export type McpTransport = 'stdio' | 'http';

export type McpStdioServerConfig = {
  id: string;
  label: string;
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type McpHttpServerConfig = {
  id: string;
  label: string;
  transport: 'http';
  url: string;
  headers: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpServerSummary = {
  id: string;
  label: string;
  transport: McpTransport;
};

const MCP_ENV_VARS = ['TUNA_MCP_SERVERS'] as const;

function readMcpEnv(): { raw: string | null; source: string | null } {
  for (const envName of MCP_ENV_VARS) {
    const raw = process.env[envName];
    if (typeof raw === 'string' && raw.trim()) {
      return { raw, source: envName };
    }
  }
  return { raw: null, source: null };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    out[trimmedKey] = raw;
  }
  return out;
}

function parseTransport(value: unknown): McpTransport | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'stdio') return 'stdio';
  if (normalized === 'http' || normalized === 'streamable_http') return 'http';
  return null;
}

function inferTransport(entry: UnknownRecord): McpTransport | null {
  const explicit = parseTransport(entry.transport);
  if (explicit) return explicit;
  if (typeof entry.url === 'string' && entry.url.trim()) return 'http';
  if (typeof entry.command === 'string' && entry.command.trim()) return 'stdio';
  return null;
}

function parseServer(entry: unknown): McpServerConfig | null {
  if (!isRecord(entry)) return null;
  const idRaw = typeof entry.id === 'string' ? entry.id : '';
  const id = normalizeId(idRaw);
  if (!id) return null;
  const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id;
  const transport = inferTransport(entry);
  if (!transport) return null;

  if (transport === 'stdio') {
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!command) return null;
    return {
      id,
      label,
      transport,
      command,
      args: toStringArray(entry.args),
      env: toStringRecord(entry.env),
    };
  }

  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (!url) return null;
  return {
    id,
    label,
    transport,
    url,
    headers: toStringRecord(entry.headers),
  };
}

export function getMcpServerConfigs(): McpServerConfig[] {
  const { raw, source } = readMcpEnv();
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to parse ${source || 'TUNA_MCP_SERVERS'}: invalid JSON.`);
    return [];
  }

  let entries: unknown[] = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.servers)) {
    entries = parsed.servers;
  } else if (isRecord(parsed) && isRecord(parsed.mcpServers)) {
    entries = Object.entries(parsed.mcpServers)
      .map(([id, value]) => (isRecord(value) ? { ...value, id } : null))
      .filter((value): value is UnknownRecord & { id: string } => Boolean(value));
  }

  const seen = new Set<string>();
  const configs: McpServerConfig[] = [];
  for (const entry of entries) {
    const config = parseServer(entry);
    if (!config) continue;
    if (seen.has(config.id)) continue;
    seen.add(config.id);
    configs.push(config);
  }
  return configs;
}

export function getMcpServerSummaries(): McpServerSummary[] {
  return getMcpServerConfigs().map((config) => ({
    id: config.id,
    label: config.label,
    transport: config.transport,
  }));
}
