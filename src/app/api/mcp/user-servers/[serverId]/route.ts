import 'server-only';

import { NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { deleteUserMcpServer, updateUserMcpServer } from '@/lib/mcp/user-servers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ serverId: string }> | { serverId: string };
};

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  return (await supabase.auth.getUser()).data.user?.id ?? null;
}

type UpdatePayload = {
  label?: string;
  url?: string;
  headers?: Record<string, string>;
};

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const userId = await getAuthedUserId();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const params = await ctx.params;
  const serverId = typeof params?.serverId === 'string' ? params.serverId : '';
  if (!serverId) {
    return Response.json({ error: 'Invalid server id' }, { status: 400 });
  }
  const payload = (await req.json().catch(() => null)) as UpdatePayload | null;
  if (!payload) {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }
  try {
    const server = await updateUserMcpServer(userId, serverId, payload);
    return Response.json({ server });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update MCP server';
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const userId = await getAuthedUserId();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const params = await ctx.params;
  const serverId = typeof params?.serverId === 'string' ? params.serverId : '';
  if (!serverId) {
    return Response.json({ error: 'Invalid server id' }, { status: 400 });
  }
  try {
    await deleteUserMcpServer(userId, serverId);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete MCP server';
    return Response.json({ error: message }, { status: 400 });
  }
}
