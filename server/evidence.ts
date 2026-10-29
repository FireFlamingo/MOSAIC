import { lookup } from 'node:dns/promises';
import type { ArtifactRequest, EvidenceField, EvidenceReport } from '../shared/types.js';

/**
 * Looks up facts about an artifact instead of trusting the caller. Registry-checkable fields come from the
 * registry; anything that cannot be checked is marked "unverified". A failed lookup is never read as
 * "does not exist": only an explicit 404 / NXDOMAIN answer is.
 */
export interface EvidenceOptions {
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  cache?: { get(key: string): EvidenceReport | undefined; set(key: string, value: EvidenceReport): void };
  timeoutMs?: number;
  now?: Date;
}

const DAY_MS = 86_400_000;
const CACHE_MS = 60 * 60 * 1000;

class NotFound extends Error {}

async function getJson(url: string, options: EvidenceOptions): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? 4_000) });
  if (response.status === 404) throw new NotFound(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

/** Splits "name", "name@1.2.3", "@scope/name" and "@scope/name@1.2.3". */
export function parseSpec(spec: string): { name: string; version?: string } {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf('@');
  if (at > 0) return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) || undefined };
  return { name: trimmed };
}

const field = <T>(value: T | undefined, from: EvidenceField<T>['from'], detail?: string): EvidenceField<T> => ({ value, from, ...(detail ? { detail } : {}) });
const unverified = (detail: string) => field<never>(undefined, 'unverified', detail);
const daysSince = (iso: string | undefined, now: Date) => (iso ? Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS)) : undefined);

async function npmEvidence(spec: string, options: EvidenceOptions, now: Date): Promise<EvidenceReport> {
  const { name, version } = parseSpec(spec);
  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const registryUrl = `https://registry.npmjs.org/${encoded}`;
  const report: EvidenceReport = { mode: 'live', registry: 'npm', lookedUp: name, fetchedAt: now.toISOString(), sources: [registryUrl], fields: {} };
  try {
    const doc = await getJson(registryUrl, options) as {
      'dist-tags'?: Record<string, string>; time?: Record<string, string>;
      versions?: Record<string, { scripts?: Record<string, string>; dist?: { attestations?: unknown } }>;
    };
    const chosen = version && !/^[~^<>=*]|\s|\|\|/.test(version) ? version : doc['dist-tags']?.latest;
    const entry = chosen ? doc.versions?.[chosen] : undefined;
    if (version && chosen === version && !entry) {
      report.fields.exists = field(false, 'registry', `Version ${version} is not published on npm.`);
      return report;
    }
    report.fields.exists = field(true, 'registry', `Published on npm${chosen ? `; checked version ${chosen}` : ''}.`);
    report.fields.signed = field(Boolean(entry?.dist?.attestations), 'registry', entry?.dist?.attestations ? 'Has a signed provenance attestation.' : 'No signed provenance attestation on this version.');
    report.fields.ageDays = field(daysSince(doc.time?.created, now), 'registry', doc.time?.created ? `First published ${doc.time.created.slice(0, 10)}.` : undefined);
    const scripts = Object.entries(entry?.scripts ?? {}).filter(([key]) => ['preinstall', 'install', 'postinstall'].includes(key));
    if (scripts.length) report.installScripts = scripts.map(([key, value]) => `${key}: ${value}`).join('\n');
    report.version = chosen;
    if (chosen && /-security$/.test(chosen)) report.takenDown = true;
  } catch (error) {
    if (error instanceof NotFound) {
      report.fields.exists = field(false, 'registry', `npm has no package named "${name}".`);
      return report;
    }
    report.fields.exists = unverified(`npm could not be reached: ${(error as Error).message}`);
    return report;
  }
  const downloadsUrl = `https://api.npmjs.org/downloads/point/last-week/${name}`;
  report.sources.push(downloadsUrl);
  try {
    const downloads = await getJson(downloadsUrl, options) as { downloads?: number };
    report.fields.downloads = field(downloads.downloads, 'registry', 'Downloads in the last 7 days.');
  } catch {
    report.fields.downloads = unverified('Download count unavailable.');
  }
  return report;
}

async function pypiEvidence(spec: string, options: EvidenceOptions, now: Date): Promise<EvidenceReport> {
  const [name, version] = spec.split('==').map((part) => part.trim());
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  const report: EvidenceReport = { mode: 'live', registry: 'pypi', lookedUp: name, fetchedAt: now.toISOString(), sources: [url], fields: {} };
  try {
    const doc = await getJson(url, options) as { info?: { version?: string }; releases?: Record<string, Array<{ upload_time_iso_8601?: string }>> };
    if (version && !doc.releases?.[version]) {
      report.fields.exists = field(false, 'registry', `Version ${version} is not published on PyPI.`);
      return report;
    }
    const uploads = Object.values(doc.releases ?? {}).flat().map((file) => file.upload_time_iso_8601).filter(Boolean).sort() as string[];
    report.fields.exists = field(true, 'registry', 'Published on PyPI.');
    report.fields.ageDays = field(daysSince(uploads[0], now), 'registry', uploads[0] ? `First release ${uploads[0].slice(0, 10)}.` : undefined);
    report.fields.signed = unverified('PyPI attestations are not checked by this version of CARD.');
    report.version = version ?? doc.info?.version;
  } catch (error) {
    report.fields.exists = error instanceof NotFound
      ? field(false, 'registry', `PyPI has no project named "${name}".`)
      : unverified(`PyPI could not be reached: ${(error as Error).message}`);
  }
  return report;
}

async function urlEvidence(target: string, options: EvidenceOptions, now: Date): Promise<EvidenceReport> {
  const report: EvidenceReport = { mode: 'live', lookedUp: target, fetchedAt: now.toISOString(), sources: [], fields: {} };
  let host: string;
  try { host = new URL(target).hostname.replace(/^\[|\]$/g, ''); } catch { return report; }
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    report.fields.exists = field(true, 'registry', 'A literal IP address needs no name lookup.');
    report.resolvedAddresses = [host];
    return report;
  }
  try {
    const addresses = await (options.resolve ?? (async (name: string) => (await lookup(name, { all: true })).map((entry) => entry.address)))(host);
    report.resolvedAddresses = addresses;
    report.fields.exists = field(true, 'registry', `Domain resolves to ${addresses.join(', ')}.`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    report.fields.exists = code === 'ENOTFOUND'
      ? field(false, 'registry', `The domain ${host} does not exist (no DNS record).`)
      : unverified(`DNS lookup failed (${code ?? 'error'}); existence not confirmed.`);
    return report;
  }
  const registrable = host.split('.').slice(-2).join('.');
  const rdapUrl = `https://rdap.org/domain/${registrable}`;
  report.sources.push(rdapUrl);
  try {
    const rdap = await getJson(rdapUrl, options) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
    const registered = rdap.events?.find((event) => event.eventAction === 'registration')?.eventDate;
    report.fields.ageDays = field(daysSince(registered, now), 'registry', registered ? `Domain registered ${registered.slice(0, 10)}.` : undefined);
  } catch {
    report.fields.ageDays = unverified('Domain registration date unavailable.');
  }
  return report;
}

/** Returns the request with registry facts in place of caller claims, plus a report of where each fact came from. */
export async function withEvidence(request: ArtifactRequest, options: EvidenceOptions = {}): Promise<{ request: ArtifactRequest; evidence: EvidenceReport }> {
  const now = options.now ?? new Date();
  const target = request.type === 'url' ? (request.source ?? request.name) : request.name;
  const key = `${request.type}|${request.ecosystem ?? ''}|${target}`;
  let report = options.cache?.get(key);
  if (!report || now.getTime() - Date.parse(report.fetchedAt) > CACHE_MS) {
    report = request.type === 'package' && request.ecosystem === 'npm' ? await npmEvidence(target, options, now)
      : request.type === 'package' && request.ecosystem === 'pypi' ? await pypiEvidence(target, options, now)
      : request.type === 'url' ? await urlEvidence(target, options, now)
      : { mode: 'live', lookedUp: target, fetchedAt: now.toISOString(), sources: [], fields: {}, note: request.type === 'package' ? 'Registry unknown, so nothing was looked up.' : 'No public registry exists for this artifact type; evidence is what the adapter observed.' };
    if (report.fields.exists?.from !== 'unverified') options.cache?.set(key, report);
  }
  const callerClaims = request.metadata ?? {};
  const value = <K extends 'exists' | 'signed' | 'ageDays' | 'downloads'>(name: K) => {
    const found = report!.fields[name];
    return found && found.from === 'registry' ? found.value : undefined;
  };
  // Packages and URLs are checkable; for them caller claims are ignored even if the lookup was impossible.
  const checked = request.type === 'package' || request.type === 'url';
  const metadata = {
    ...(callerClaims.permissions ? { permissions: callerClaims.permissions } : {}),
    // Registry-checkable fields never fall back to caller claims: unverifiable means unknown.
    exists: checked ? value('exists') as boolean | undefined : callerClaims.exists,
    signed: checked ? value('signed') as boolean | undefined : callerClaims.signed,
    ageDays: checked ? value('ageDays') as number | undefined : callerClaims.ageDays,
    downloads: checked ? value('downloads') as number | undefined : callerClaims.downloads,
    ...(report.resolvedAddresses ? { resolvedAddresses: report.resolvedAddresses } : {}),
    ...(report.takenDown ? { takenDown: true } : {}),
  };
  const content = report.installScripts ? `${request.content ? `${request.content}\n` : ''}--- install scripts (from registry) ---\n${report.installScripts}` : request.content;
  return {
    request: { ...request, metadata, ...(content !== undefined ? { content } : {}) },
    evidence: { ...report, callerClaims: Object.keys(callerClaims).length ? callerClaims : undefined },
  };
}
