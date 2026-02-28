const STRIPPED_AUTH_PARAMS = [
  "code",
  "next",
  "error",
  "error_description",
  "error_code",
];

export function sanitizeNextRedirect(
  next: string | null | undefined,
  fallback = "/"
): string {
  if (!next) return fallback;
  const trimmed = next.trim();
  if (!trimmed) return fallback;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;

  try {
    const url = new URL(trimmed, "http://localhost");
    for (const param of STRIPPED_AUTH_PARAMS) {
      url.searchParams.delete(param);
    }
    const search = url.searchParams.toString();
    const normalized = `${url.pathname}${search ? `?${search}` : ""}${url.hash || ""}`;
    return normalized.startsWith("/") ? normalized : fallback;
  } catch {
    return fallback;
  }
}
