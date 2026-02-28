function normalizeServerIds(ids: string[] | undefined | null): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function getDefaultMcpEnabledServers(availableServerIds?: string[]): string[] {
  return Array.from(new Set(normalizeServerIds(availableServerIds)));
}
