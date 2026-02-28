import 'server-only';

import { NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import {
  deleteIntegrationToken,
  getIntegrationToken,
  parseIntegrationProvider,
  upsertIntegrationToken,
} from '@/lib/integrations/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type IntegrationContext = {
  params: Promise<{ provider: string }> | { provider: string };
};

type IntegrationPayload = {
  token?: string;
};

function badProvider() {
  return Response.json({ error: 'Unsupported integration provider' }, { status: 404 });
}

async function getAuthedUserId(): Promise<string | null> {
  const supabase = await createClient();
  return (await supabase.auth.getUser()).data.user?.id ?? null;
}

export async function GET(_req: NextRequest, ctx: IntegrationContext) {
  const params = await ctx.params;
  const provider = parseIntegrationProvider(typeof params?.provider === 'string' ? params.provider : '');
  if (!provider) {
    return badProvider();
  }
  const userId = await getAuthedUserId();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  try {
    const token = await getIntegrationToken(userId, provider);
    return Response.json({ provider, hasToken: Boolean(token) });
  } catch (error) {
    console.error('Failed to load integration token status:', error);
    return Response.json({ error: 'Failed to load integration status' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, ctx: IntegrationContext) {
  const params = await ctx.params;
  const provider = parseIntegrationProvider(typeof params?.provider === 'string' ? params.provider : '');
  if (!provider) {
    return badProvider();
  }
  const userId = await getAuthedUserId();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const payload = (await req.json().catch(() => null)) as IntegrationPayload | null;
  const token = payload?.token?.trim() ?? '';
  if (!token) {
    return Response.json({ error: 'Missing token' }, { status: 400 });
  }
  try {
    await upsertIntegrationToken(userId, provider, token);
    return Response.json({ provider, hasToken: true });
  } catch (error) {
    console.error('Failed to save integration token:', error);
    return Response.json({ error: 'Failed to save integration token' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: IntegrationContext) {
  const params = await ctx.params;
  const provider = parseIntegrationProvider(typeof params?.provider === 'string' ? params.provider : '');
  if (!provider) {
    return badProvider();
  }
  const userId = await getAuthedUserId();
  if (!userId) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  try {
    await deleteIntegrationToken(userId, provider);
    return Response.json({ provider, hasToken: false });
  } catch (error) {
    console.error('Failed to remove integration token:', error);
    return Response.json({ error: 'Failed to remove integration token' }, { status: 500 });
  }
}
