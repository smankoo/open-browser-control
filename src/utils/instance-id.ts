/**
 * Returns a stable per-install UUID for this extension, generating and
 * persisting one in chrome.storage.local on first access.
 *
 * The bridge uses this to distinguish a reconnect of the same extension
 * (OK — replace the old socket) from a second, different extension trying
 * to claim the same port (conflict — reject with close code 4002).
 */

const STORAGE_KEY = 'obc_instance_id';

export async function getInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const existing = stored[STORAGE_KEY];
  if (typeof existing === 'string' && existing) return existing;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
  return fresh;
}
