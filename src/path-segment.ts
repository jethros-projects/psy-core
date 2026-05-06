export function pathSegment(value: unknown, fallback = 'unknown'): string {
  const raw = typeof value === 'string' && value.length > 0 ? value : fallback;
  return encodeURIComponent(raw.length > 0 ? raw : fallback);
}
