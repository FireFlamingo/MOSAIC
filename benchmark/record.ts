/**
 * Records the real registry and DNS answers for every package and URL in the corpus, once, so benchmark runs
 * replay real data deterministically. Run with `npx tsx benchmark/record.ts` (needs network).
 * Only the fields CARD reads are kept (npm package documents can be megabytes).
 */
import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withEvidence } from '../server/evidence.js';
import { buildHoldout, buildScenarios } from './corpus.js';
import type { ArtifactRequest } from '../shared/types.js';

const HOLDOUT = process.argv.includes('--holdout');
export const RECORDING = fileURLToPath(new URL(HOLDOUT ? './recordings/holdout-evidence.json' : './recordings/evidence.json', import.meta.url));
export interface Recording { recordedAt: string; http: Record<string, { status: number; body?: unknown }>; dns: Record<string, { addresses?: string[]; code?: string }> }

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

function trim(url: string, body: Record<string, unknown>): unknown {
  if (url.startsWith('https://registry.npmjs.org/')) {
    const tags = body['dist-tags'] as Record<string, string> | undefined;
    const latest = tags?.latest;
    const version = latest ? (body.versions as Record<string, { scripts?: Record<string, string>; dist?: { attestations?: unknown } }> | undefined)?.[latest] : undefined;
    const scripts = Object.fromEntries(Object.entries(version?.scripts ?? {}).filter(([key]) => INSTALL_SCRIPTS.includes(key)));
    return {
      'dist-tags': latest ? { latest } : {},
      time: { created: (body.time as Record<string, string> | undefined)?.created },
      versions: latest ? { [latest]: { scripts, dist: version?.dist?.attestations ? { attestations: { present: true } } : {} } } : {},
    };
  }
  if (url.startsWith('https://pypi.org/pypi/')) {
    const releases = body.releases as Record<string, Array<{ upload_time_iso_8601?: string }>> | undefined;
    const earliest = Object.entries(releases ?? {}).map(([version, files]) => [version, files.map((file) => file.upload_time_iso_8601).filter(Boolean).sort()[0]] as const)
      .filter(([, time]) => time).sort((a, b) => String(a[1]).localeCompare(String(b[1])))[0];
    return { info: { version: (body.info as { version?: string } | undefined)?.version }, releases: earliest ? { [earliest[0]]: [{ upload_time_iso_8601: earliest[1] }] } : {} };
  }
  if (url.startsWith('https://rdap.org/')) {
    const registration = (body.events as Array<{ eventAction?: string; eventDate?: string }> | undefined)?.find((event) => event.eventAction === 'registration');
    return { events: registration ? [registration] : [] };
  }
  if (url.startsWith('https://api.npmjs.org/downloads/')) return { downloads: body.downloads };
  return {};
}

async function main() {
  const recording: Recording = { recordedAt: new Date().toISOString(), http: {}, dns: {} };
  const recordingFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const response = await fetch(url, init);
    let body: unknown;
    try { body = trim(url, await response.json() as Record<string, unknown>); } catch { body = undefined; }
    recording.http[url] = { status: response.status, ...(body !== undefined ? { body } : {}) };
    return new Response(JSON.stringify(body ?? {}), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const recordingResolve = async (host: string) => {
    try {
      const addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
      recording.dns[host] = { addresses };
      return addresses;
    } catch (error) {
      recording.dns[host] = { code: (error as NodeJS.ErrnoException).code ?? 'ERROR' };
      throw error;
    }
  };
  const requests = new Map<string, Omit<ArtifactRequest, 'sessionId'>>();
  for (const scenario of HOLDOUT ? buildHoldout() : buildScenarios()) {
    for (const event of scenario.events) {
      if ('request' in event && (event.request.type === 'package' || event.request.type === 'url')) requests.set(JSON.stringify([event.request.type, event.request.ecosystem, event.request.name, event.request.source]), event.request);
    }
  }
  let done = 0;
  const queue = [...requests.values()];
  // A few lookups at a time, to stay polite to the registries.
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let request = queue.shift(); request; request = queue.shift()) {
      await withEvidence({ ...request, sessionId: 'record' }, { fetch: recordingFetch, resolve: recordingResolve, timeoutMs: 15_000 });
      done += 1;
      if (done % 25 === 0) console.log(`  ${done}/${requests.size}`);
    }
  }));
  await mkdir(dirname(RECORDING), { recursive: true });
  const sorted = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(RECORDING, `${JSON.stringify({ recordedAt: recording.recordedAt, http: sorted(recording.http), dns: sorted(recording.dns) }, null, 1)}\n`);
  console.log(`Recorded ${Object.keys(recording.http).length} HTTP answers and ${Object.keys(recording.dns).length} DNS answers for ${requests.size} artifacts to ${RECORDING}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
