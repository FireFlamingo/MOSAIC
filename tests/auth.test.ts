import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp, type AppOptions } from '../server/index.js';
import { signIn, TEST_REVIEWER } from './helpers.js';

async function withApp(options: Omit<AppOptions, 'dataDir'>, fn: (base: string, app: Awaited<ReturnType<typeof createApp>>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'card-auth-'));
  const card = await createApp({ dataDir: directory, seed: false, ...options });
  const server = card.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try { await fn(base, card, directory); } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    card.store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const json = (body: unknown, cookie?: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const artifact = { type: 'package', name: 'test-kit', sessionId: 's', metadata: { exists: true, signed: true, permissions: ['secrets:read'] } };

test('an agent calling the API without the reviewer session cannot approve, revoke or change policy', () => withApp({ reviewer: TEST_REVIEWER }, async (base) => {
  const evaluation = await (await fetch(`${base}/api/evaluate`, json(artifact))).json();
  assert.equal(evaluation.decision, 'review', 'evaluation stays open to adapters');
  const review = await fetch(`${base}/api/reviews/${evaluation.id}`, json({ decision: 'allow', note: 'self-approval', reason: 'expected-tool', remember: true }));
  assert.equal(review.status, 401);
  assert.equal((await fetch(`${base}/api/rules/any/revoke`, json({ note: 'x' }))).status, 401);
  assert.equal((await fetch(`${base}/api/policy`, { ...json({ reviewThreshold: 90, denyThreshold: 95, correlationEnabled: false }), method: 'PATCH' })).status, 401);
  const forged = await fetch(`${base}/api/reviews/${evaluation.id}`, json({ decision: 'allow', note: 'x', reason: 'expected-tool' }, 'card_session=guessed-token'));
  assert.equal(forged.status, 401, 'a made-up session token is rejected');
  const cookie = await signIn(base);
  assert.equal((await fetch(`${base}/api/reviews/${evaluation.id}`, json({ decision: 'allow', note: 'approved by a person', reason: 'expected-tool' }, cookie))).status, 200);
}));

test('the session cookie is HttpOnly and SameSite=Strict, and locking ends it', () => withApp({ reviewer: TEST_REVIEWER }, async (base) => {
  const response = await fetch(`${base}/api/auth/unlock`, json({ pin: TEST_REVIEWER.pin }));
  const header = response.headers.get('set-cookie')!;
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  const cookie = header.split(';')[0];
  assert.deepEqual(await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json(), { configured: true, unlocked: true, reviewer: 'Tester' });
  await fetch(`${base}/api/auth/lock`, json({}, cookie));
  assert.equal((await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json()).unlocked, false);
}));

test('five wrong PINs lock sign-in, even for the right PIN', () => withApp({ reviewer: TEST_REVIEWER }, async (base) => {
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await fetch(`${base}/api/auth/unlock`, json({ pin: 'wrong-pin-0' }))).status, 401);
  assert.equal((await fetch(`${base}/api/auth/unlock`, json({ pin: TEST_REVIEWER.pin }))).status, 429);
}));

test('first-time setup needs the console code, rejects weak PINs, and stores only a hash', () => withApp({}, async (base, card, directory) => {
  assert.deepEqual(await (await fetch(`${base}/api/auth/status`)).json(), { configured: false, unlocked: false });
  assert.ok(card.auth.setupCode);
  assert.equal((await fetch(`${base}/api/auth/setup`, json({ code: '000-000', name: 'Ayush', pin: 'good-pin-77' }))).status, 403);
  assert.equal((await fetch(`${base}/api/auth/setup`, json({ code: card.auth.setupCode, name: 'Ayush', pin: '123' }))).status, 400);
  const ok = await fetch(`${base}/api/auth/setup`, json({ code: card.auth.setupCode, name: 'Ayush', pin: 'good-pin-77' }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).reviewer, 'Ayush');
  assert.equal((await fetch(`${base}/api/auth/setup`, json({ code: card.auth.setupCode, name: 'Agent', pin: 'agent-pin-1' }))).status, 409, 'setup works only once');
  const stored = readFileSync(join(directory, 'reviewer.json'), 'utf8');
  assert.doesNotMatch(stored, /good-pin-77/);
  assert.match(stored, /"hash"/);
}));
