import 'server-only';

import { isIP } from 'node:net';

const MAX_URL_LENGTH = 2048;
const MAX_HEADER_KEY_LENGTH = 200;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_COUNT = 20;

const PRIVATE_HOST_SUFFIXES = ['.local', '.internal'];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((segment) => Number.parseInt(segment, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  const ipType = isIP(normalized);
  if (ipType === 4) return isPrivateIpv4(normalized);
  if (ipType === 6) return true;
  return false;
}

export function validateMcpServerUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'URL is required.' };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, error: 'URL is too long.' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'URL must be a valid HTTPS address.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTPS MCP servers are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not include credentials.' };
  }
  if (isPrivateHostname(parsed.hostname)) {
    return { ok: false, error: 'Private or local MCP servers are not allowed.' };
  }
  return { ok: true, url: parsed.toString() };
}

export function normalizeHeaderRecord(input?: Record<string, string>): Record<string, string> {
  if (!input) return {};
  const entries = Object.entries(input)
    .map(([key, value]) => [key.trim(), String(value ?? '').trim()] as const)
    .filter(([key, value]) => Boolean(key) && Boolean(value));
  const trimmed = entries.slice(0, MAX_HEADER_COUNT);
  const out: Record<string, string> = {};
  for (const [key, value] of trimmed) {
    if (key.length > MAX_HEADER_KEY_LENGTH || value.length > MAX_HEADER_VALUE_LENGTH) continue;
    if (key.includes('\n') || key.includes('\r') || value.includes('\n') || value.includes('\r')) continue;
    out[key] = value;
  }
  return out;
}
