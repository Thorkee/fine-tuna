export const MCP_TOOL_PREFIX = 'mcp.';

export function buildMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}.${toolName}`;
}

export function parseMcpToolName(toolName: string): { serverId: string; toolName: string } | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const remainder = toolName.slice(MCP_TOOL_PREFIX.length);
  const splitIdx = remainder.indexOf('.');
  if (splitIdx <= 0) return null;
  const serverId = remainder.slice(0, splitIdx).trim();
  const innerName = remainder.slice(splitIdx + 1).trim();
  if (!serverId || !innerName) return null;
  return { serverId, toolName: innerName };
}
