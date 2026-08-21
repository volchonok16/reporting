/** Prefix for same-origin embed under reporting (`/voice`). */

const configuredBase = (
  process.env.NEXT_PUBLIC_VOICE_BASE_PATH ||
  process.env.VOICE_BASE_PATH ||
  "/voice"
).replace(/\/$/, "");

/** Absolute app path including basePath (for location.assign / replaceState). */
export function appHref(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!configuredBase) return normalized;
  if (normalized === configuredBase || normalized.startsWith(`${configuredBase}/`)) {
    return normalized;
  }
  return `${configuredBase}${normalized}`;
}
