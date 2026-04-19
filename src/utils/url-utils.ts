/**
 * Return true if `url` is safe for the extension to hand to tabs.create
 * or tabs.update. Restricts protocols to http(s) to keep agents from
 * opening file://, chrome://, javascript:, data:, or extension-internal URLs.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
