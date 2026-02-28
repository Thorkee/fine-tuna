import 'server-only';

import { getIntegrationToken } from '@/lib/integrations/tokens';
import type { McpServerConfig } from './config';

const FIRECRAWL_SERVER_ID = 'firecrawl-mcp';
const FIRECRAWL_ENV_KEY = 'FIRECRAWL_API_KEY';

function resolveEnvReference(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('$')) return trimmed || undefined;
  const key = trimmed.replace(/^\$\{?([^}]+)\}?$/, '$1').trim();
  if (!key) return undefined;
  const envValue = (process.env[key] || '').trim();
  return envValue || undefined;
}

function readServerEnvToken(server: McpServerConfig): string | undefined {
  if (server.transport !== 'stdio') return undefined;
  const raw = server.env?.[FIRECRAWL_ENV_KEY];
  if (!raw) return undefined;
  return resolveEnvReference(raw);
}

function readEnvFallback(): string | undefined {
  const value = (process.env.FIRECRAWL_API_KEY || '').trim();
  return value || undefined;
}

function resolveFirecrawlToken(server: McpServerConfig): string | undefined {
  if (server.transport !== 'stdio') return undefined;
  return readServerEnvToken(server) ?? readEnvFallback();
}

export function hasFirecrawlToken(server: McpServerConfig): boolean {
  return Boolean(resolveFirecrawlToken(server));
}

async function resolveUserToken(userId?: string | null): Promise<string | undefined> {
  const id = String(userId || '').trim();
  if (!id) return undefined;
  try {
    const token = await getIntegrationToken(id, 'firecrawl');
    return token || undefined;
  } catch {
    return undefined;
  }
}

export async function applyFirecrawlTokenToMcpServers(
  servers: McpServerConfig[],
  userId?: string | null
): Promise<McpServerConfig[]> {
  if (!Array.isArray(servers) || servers.length === 0) return servers;
  const userToken = await resolveUserToken(userId);
  return servers.map((server) => {
    if (server.id !== FIRECRAWL_SERVER_ID || server.transport !== 'stdio') {
      return server;
    }
    const fallbackToken = resolveFirecrawlToken(server);
    const token = userToken ?? fallbackToken;
    if (!token) return server;
    const env = { ...(server.env ?? {}) };
    if (env[FIRECRAWL_ENV_KEY] === token) return server;
    env[FIRECRAWL_ENV_KEY] = token;
    return { ...server, env };
  });
}
