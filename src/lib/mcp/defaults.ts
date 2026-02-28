export const DEFAULT_MCP_ENABLED_SERVERS = ['firecrawl-mcp'] as const;

function normalizeServerIds(ids: string[] | undefined | null): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function getDefaultMcpEnabledServers(availableServerIds?: string[]): string[] {
  const normalizedAvailable = normalizeServerIds(availableServerIds);
  if (normalizedAvailable.length > 0) {
    return Array.from(new Set(normalizedAvailable));
  }
  return [...DEFAULT_MCP_ENABLED_SERVERS];
}
