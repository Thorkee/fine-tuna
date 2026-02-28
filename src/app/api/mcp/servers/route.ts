import 'server-only';

import { NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { getMcpServerSummaries } from '@/lib/mcp/config';
import { listUserMcpServerSummaries } from '@/lib/mcp/user-servers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  return (await supabase.auth.getUser()).data.user?.id ?? null;
}

export async function GET(_req: NextRequest) {
  const userId = await getAuthedUserId();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const envServers = getMcpServerSummaries().map((server) => ({
    ...server,
    origin: 'env' as const,
  }));
  const userServers = await listUserMcpServerSummaries(userId);
  const servers = [...envServers, ...userServers];
  return Response.json({ servers });
}
