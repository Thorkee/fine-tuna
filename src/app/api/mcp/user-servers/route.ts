import 'server-only';

import { NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { createUserMcpServer } from '@/lib/mcp/user-servers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  return (await supabase.auth.getUser()).data.user?.id ?? null;
}

type CreatePayload = {
  label?: string;
  url?: string;
  headers?: Record<string, string>;
};

export async function POST(req: NextRequest) {
  const userId = await getAuthedUserId();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const payload = (await req.json().catch(() => null)) as CreatePayload | null;
  if (!payload) {
    return Response.json({ error: 'Invalid payload' }, { status: 400 });
  }
  try {
    const server = await createUserMcpServer(userId, {
      label: payload.label ?? '',
      url: payload.url ?? '',
      headers: payload.headers,
    });
    return Response.json({ server }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create MCP server';
    return Response.json({ error: message }, { status: 400 });
  }
}
