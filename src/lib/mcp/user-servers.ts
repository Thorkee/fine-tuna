import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeHeaderRecord, validateMcpServerUrl } from './validation';

export type UserMcpServerRecord = {
  id: string;
  user_id: string;
  label: string;
  transport: 'http';
  url: string;
  headers: Record<string, string> | null;
  created_at: string;
  updated_at: string;
};

export type UserMcpServerSummary = {
  id: string;
  label: string;
  transport: 'http';
  origin: 'user';
};

export type UserMcpServerInput = {
  label: string;
  url: string;
  headers?: Record<string, string>;
};

export type UserMcpServerUpdate = Partial<UserMcpServerInput>;

function normalizeLabel(value: string): string {
  return value.trim();
}

export async function listUserMcpServers(userId: string): Promise<UserMcpServerRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_mcp_servers')
    .select('id, user_id, label, transport, url, headers, created_at, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) {
    throw new Error(error.message);
  }
  return (data as UserMcpServerRecord[]) ?? [];
}

export async function listUserMcpServerSummaries(userId: string): Promise<UserMcpServerSummary[]> {
  const rows = await listUserMcpServers(userId);
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    transport: row.transport,
    origin: 'user',
  }));
}

export async function createUserMcpServer(
  userId: string,
  input: UserMcpServerInput
): Promise<UserMcpServerSummary> {
  const label = normalizeLabel(input.label);
  if (!label) throw new Error('Label is required.');
  const urlCheck = validateMcpServerUrl(input.url);
  if (!urlCheck.ok) throw new Error(urlCheck.error);
  const headers = normalizeHeaderRecord(input.headers);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_mcp_servers')
    .insert([
      {
        user_id: userId,
        label,
        transport: 'http',
        url: urlCheck.url,
        headers: Object.keys(headers).length > 0 ? headers : null,
      },
    ])
    .select('id, label, transport')
    .single();
  if (error) {
    throw new Error(error.message);
  }
  return { id: data.id, label: data.label, transport: data.transport, origin: 'user' };
}

export async function updateUserMcpServer(
  userId: string,
  serverId: string,
  input: UserMcpServerUpdate
): Promise<UserMcpServerSummary> {
  const updates: Record<string, unknown> = {};
  if (typeof input.label === 'string') {
    const label = normalizeLabel(input.label);
    if (!label) throw new Error('Label is required.');
    updates.label = label;
  }
  if (typeof input.url === 'string') {
    const urlCheck = validateMcpServerUrl(input.url);
    if (!urlCheck.ok) throw new Error(urlCheck.error);
    updates.url = urlCheck.url;
  }
  if (input.headers) {
    const headers = normalizeHeaderRecord(input.headers);
    updates.headers = Object.keys(headers).length > 0 ? headers : null;
  }
  if (Object.keys(updates).length === 0) {
    throw new Error('No updates provided.');
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_mcp_servers')
    .update(updates)
    .eq('id', serverId)
    .eq('user_id', userId)
    .select('id, label, transport')
    .single();
  if (error) {
    throw new Error(error.message);
  }
  return { id: data.id, label: data.label, transport: data.transport, origin: 'user' };
}

export async function deleteUserMcpServer(userId: string, serverId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('user_mcp_servers')
    .delete()
    .eq('id', serverId)
    .eq('user_id', userId);
  if (error) {
    throw new Error(error.message);
  }
}

export async function isMcpToolApproved(
  userId: string,
  serverId: string,
  toolName: string
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_mcp_tool_approvals')
    .select('tool_name')
    .eq('user_id', userId)
    .eq('server_id', serverId)
    .eq('tool_name', toolName)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return Boolean(data?.tool_name);
}

export async function recordMcpToolApproval(
  userId: string,
  serverId: string,
  toolName: string
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('user_mcp_tool_approvals')
    .upsert(
      {
        user_id: userId,
        server_id: serverId,
        tool_name: toolName,
      },
      { onConflict: 'user_id,server_id,tool_name' }
    );
  if (error) {
    throw new Error(error.message);
  }
}
