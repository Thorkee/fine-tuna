import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

export type IntegrationProvider = 'huggingface' | 'github' | 'kaggle' | 'firecrawl';

const INTEGRATION_PROVIDERS: ReadonlySet<IntegrationProvider> = new Set([
  'huggingface',
  'github',
  'kaggle',
  'firecrawl',
]);

export function isIntegrationProvider(value: string): value is IntegrationProvider {
  return INTEGRATION_PROVIDERS.has(value as IntegrationProvider);
}

export function parseIntegrationProvider(value: string): IntegrationProvider | null {
  const normalized = value.trim().toLowerCase();
  return isIntegrationProvider(normalized) ? normalized : null;
}

export async function getIntegrationToken(
  userId: string,
  provider: IntegrationProvider
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_integrations')
    .select('access_token')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  const token = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
  return token || null;
}

export async function upsertIntegrationToken(
  userId: string,
  provider: IntegrationProvider,
  token: string
): Promise<void> {
  const admin = createAdminClient();
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error('Token is required');
  }
  const { error } = await admin.from('user_integrations').upsert(
    {
      user_id: userId,
      provider,
      access_token: trimmed,
    },
    { onConflict: 'user_id,provider' }
  );
  if (error) {
    throw new Error(error.message);
  }
}

export async function deleteIntegrationToken(userId: string, provider: IntegrationProvider): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('user_integrations')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) {
    throw new Error(error.message);
  }
}
