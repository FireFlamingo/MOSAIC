export const TEST_REVIEWER = { name: 'Tester', pin: 'test-pin-1234' };

/** Signs in as the preset test reviewer and returns the session cookie. */
export async function signIn(base: string, pin = TEST_REVIEWER.pin): Promise<string> {
  const response = await fetch(`${base}/api/auth/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
  if (response.status !== 200) throw new Error(`Sign-in failed with ${response.status}`);
  return response.headers.get('set-cookie')!.split(';')[0];
}

/** Makes every request to `base` carry the reviewer session, as a signed-in browser would. Returns an undo function. */
export function useSession(base: string, cookie: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    if (!String(input).startsWith(base)) return original(input, init);
    const headers = new Headers(init.headers);
    if (!headers.has('cookie')) headers.set('cookie', cookie);
    return original(input, { ...init, headers });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
