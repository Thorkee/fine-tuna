import 'server-only';

type AnyRecord = Record<string, unknown>;

export function isUuid(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function parsePositiveIntEnv(...names: string[]): number | null {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return parsed;
  }
  return null;
}

export function getE2bSessionCreditsPerMinute(): number | null {
  return parsePositiveIntEnv('TUNA_E2B_SESSION_CREDITS_PER_MINUTE');
}

export function getE2bTrainingCreditsPerMinute(): number | null {
  return parsePositiveIntEnv('TUNA_E2B_TRAINING_CREDITS_PER_MINUTE');
}

export function computeElapsedMinutesCeil(startedAtIso: string, now: Date = new Date()): number | null {
  const started = new Date(startedAtIso);
  if (Number.isNaN(started.getTime())) return null;
  const elapsedMs = now.getTime() - started.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.ceil(elapsedMs / 60_000);
}

export function addMinutesIso(startedAtIso: string, minutes: number): string | null {
  const started = new Date(startedAtIso);
  if (Number.isNaN(started.getTime())) return null;
  const safeMinutes = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  return new Date(started.getTime() + safeMinutes * 60_000).toISOString();
}

export function isInsufficientCreditsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as AnyRecord;
  const message =
    typeof rec.message === 'string'
      ? rec.message
      : typeof rec.error === 'string'
        ? rec.error
        : typeof rec.details === 'string'
          ? rec.details
          : '';
  return message.toLowerCase().includes('insufficient_credits');
}

