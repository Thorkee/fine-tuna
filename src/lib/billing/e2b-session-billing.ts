import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { getE2bSessionCreditsPerMinute, isInsufficientCreditsError, isUuid } from '@/lib/billing/e2b';

export async function maybeBillSandboxSession(params: {
  userId: string;
  chatId: string;
  sessionId: string;
}): Promise<{ blocked?: 'insufficient_credits' } | null> {
  const rate = getE2bSessionCreditsPerMinute();
  if (!rate) return null;
  if (!isUuid(params.sessionId)) return null;
  if (!isUuid(params.userId)) return null;
  if (!isUuid(params.chatId)) return null;

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return null;
  }

  try {
    const { data, error } = await admin.rpc('bill_e2b_session_minutes', {
      p_session_id: params.sessionId,
      p_user_id: params.userId,
      p_chat_id: params.chatId,
      p_credits_per_minute: rate,
      p_started_at: null,
    });

    if (error) {
      if (isInsufficientCreditsError(error)) {
        return { blocked: 'insufficient_credits' };
      }
      return null;
    }

    if (data && typeof data === 'object' && (data as { blocked?: string }).blocked === 'insufficient_credits') {
      return { blocked: 'insufficient_credits' };
    }
  } catch {
    return null;
  }

  return null;
}

