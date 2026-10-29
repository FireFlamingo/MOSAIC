/**
 * Runs the benchmark through CARD's production path (StateStore, live-evidence merge, decision memory,
 * Layer 2) using the recorded registry and DNS answers, and writes output/benchmark/.
 * `npm run benchmark`. Layer 1 = cross-artifact correlation and chain analysis off; full = on.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/index.js';
import { evaluateRisk } from '../server/engine.js';
import { withEvidence } from '../server/evidence.js';
import { RECOMMENDED_POLICY } from '../shared/scoring.js';
import type { Evaluation } from '../shared/types.js';
import { buildScenarios, type Scenario } from './corpus.js';
import type { Recording } from './record.js';

const OUT = fileURLToPath(new URL('../output/benchmark/', import.meta.url));
const RECORDING = fileURLToPath(new URL('./recordings/evidence.json', import.meta.url));
const popular = JSON.parse(await readFile(fileURLToPath(new URL('../shared/reference/popular-packages.json', import.meta.url)), 'utf8')) as { npm: string[]; pypi: string[] };

interface Outcome { id: string; category: string; label: Scenario['label']; type: string; split: 'train' | 'test'; score: number; decision: Evaluation['decision']; flagged: boolean; floor?: string; memory: boolean; confidence?: Evaluation['confidence']; signals: string[]; ms: number }

const npmLatest = (recording: Recording, name: string) => {
  const entry = recording.http[`https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`];
  return entry?.status === 200 ? (entry.body as { 'dist-tags'?: { latest?: string } })['dist-tags']?.latest : entry?.status === 404 ? '404' : undefined;
};
const pypiStatus = (recording: Recording, name: string) => recording.http[`https://pypi.org/pypi/${encodeURIComponent(name)}/json`]?.status;
const host = (target: string) => { try { return new URL(target).hostname; } catch { return ''; } };

/** Ground-truth rules that depend on recorded facts. A scenario that fails its rule is excluded, with the reason counted. */
function admissible(scenario: Scenario, recording: Recording): string | undefined {
  const target = scenario.events.find((event) => 'request' in event && event.target) as Extract<Scenario['events'][number], { request: unknown }>;
  const { request } = target;
  const id = scenario.id;
  if (/^A1-/.test(id) && npmLatest(recording, request.name) !== '404') return 'hallucinated npm name turned out to be registered';
  if (/^A1p-/.test(id) && pypiStatus(recording, request.name) !== 404) return 'hallucinated PyPI name turned out to be registered';
  if (/^A2-/.test(id) && popular.npm.includes(request.name)) return 'typo variant is itself a popular package';
  if (/^A2p-/.test(id) && popular.pypi.includes(request.name)) return 'typo variant is itself a popular project';
  if (/^(A3|A11)-/.test(id) && !/-security$/.test(npmLatest(recording, request.name) ?? '')) return 'not (or no longer) an npm security holding package';
  if (/^A4-/.test(id) && recording.dns[host(request.source ?? request.name)]?.code !== 'ENOTFOUND') return 'hallucinated domain turned out to exist';
  return undefined;
}

function replay(recording: Recording) {
  return {
    fetch: (async (input: string | URL) => {
      const entry = recording.http[String(input)];
      if (!entry) throw new Error(`not recorded: ${String(input)}`);
      return new Response(JSON.stringify(entry.body ?? {}), { status: entry.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
    resolve: async (name: string) => {
      const entry = recording.dns[name];
      if (!entry) throw Object.assign(new Error('not recorded'), { code: 'EAI_AGAIN' });
      if (entry.code) throw Object.assign(new Error(entry.code), { code: entry.code });
      return entry.addresses ?? [];
    },
  };
}

const split = (id: string): 'train' | 'test' => (createHash('sha256').update(id).digest()[0] % 2 === 0 ? 'train' : 'test');

async function runConfiguration(scenarios: Scenario[], recording: Recording, correlationEnabled: boolean): Promise<Outcome[]> {
  const directory = await mkdtemp(join(tmpdir(), 'card-benchmark-'));
  const { store } = await createApp({ dataDir: directory, seed: false });
  const now = new Date(recording.recordedAt);
  const { fetch, resolve } = replay(recording);
  const outcomes: Outcome[] = [];
  try {
    await store.setPolicy({ ...RECOMMENDED_POLICY, correlationEnabled });
    for (const scenario of scenarios) {
      for (const event of scenario.events) {
        if ('observe' in event) { store.addObservation({ sessionId: scenario.id, ...event.observe }); continue; }
        const request = { ...event.request, sessionId: scenario.id };
        const started = performance.now();
        const looked = request.type === 'package' || request.type === 'url' ? await withEvidence(request, { fetch, resolve, now }) : undefined;
        const evaluation = await store.evaluate(looked?.request ?? request, evaluateRisk, now, looked?.evidence);
        const ms = performance.now() - started;
        if (event.pin) await store.review(evaluation.id, { decision: 'allow', note: 'Pinned by the benchmark reviewer', reason: 'expected-tool', reviewer: 'benchmark', remember: true }, now);
        if (!event.target) continue;
        outcomes.push({
          id: scenario.id, category: scenario.category, label: scenario.label, type: request.type, split: split(scenario.id),
          score: evaluation.score, decision: evaluation.decision, flagged: evaluation.decision !== 'allow',
          ...(evaluation.decisionFloor ? { floor: evaluation.decisionFloor.signalId } : {}), memory: Boolean(evaluation.memory?.applied || evaluation.memory?.changedSinceTrust),
          confidence: evaluation.confidence, signals: evaluation.signals.map((signal) => signal.id).sort(), ms,
        });
      }
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
  return outcomes;
}

const rate = (top: number, bottom: number) => (bottom ? Math.round((top / bottom) * 1000) / 1000 : null);
function summarize(outcomes: Outcome[]) {
  const tp = outcomes.filter((o) => o.label === 'malicious' && o.flagged).length;
  const fn = outcomes.filter((o) => o.label === 'malicious' && !o.flagged).length;
  const fp = outcomes.filter((o) => o.label === 'benign' && o.flagged).length;
  const tn = outcomes.filter((o) => o.label === 'benign' && !o.flagged).length;
  return { n: outcomes.length, tp, fp, fn, tn, detectionRate: rate(tp, tp + fn), falsePositiveRate: rate(fp, fp + tn), precision: rate(tp, tp + fp), f1: rate(2 * tp, 2 * tp + fp + fn) };
}
const byKey = (outcomes: Outcome[], key: (o: Outcome) => string) => {
  const groups = new Map<string, Outcome[]>();
  for (const outcome of outcomes) groups.set(key(outcome), [...(groups.get(key(outcome)) ?? []), outcome]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => [name, { ...summarize(list), flagged: list.filter((o) => o.flagged).length }]));
};

/** Flag decision at another review threshold: rules and floors still decide on their own. */
const flaggedAt = (outcome: Outcome, threshold: number) => outcome.memory || outcome.floor ? outcome.flagged : outcome.score >= threshold;

function thresholdStudy(outcomes: Outcome[]) {
  const candidates = Array.from({ length: 21 }, (_, i) => i * 5);
  const youden = (list: Outcome[], t: number) => {
    const malicious = list.filter((o) => o.label === 'malicious');
    const benign = list.filter((o) => o.label === 'benign');
    return malicious.filter((o) => flaggedAt(o, t)).length / malicious.length - benign.filter((o) => flaggedAt(o, t)).length / benign.length;
  };
  const train = outcomes.filter((o) => o.split === 'train');
  const test = outcomes.filter((o) => o.split === 'test');
  const best = candidates.reduce((a, b) => (youden(train, b) > youden(train, a) + 1e-9 || (Math.abs(youden(train, b) - youden(train, a)) < 1e-9 && Math.abs(b - 20) < Math.abs(a - 20)) ? b : a));
  const at = (list: Outcome[], t: number) => summarize(list.map((o) => ({ ...o, flagged: flaggedAt(o, t) })));
  return { method: 'Review threshold chosen on the train split by Youden J (detection rate minus false-positive rate), ties broken toward the default 20; reported on the held-out test split.', trainSize: train.length, testSize: test.length, chosen: best, testAtDefault: at(test, RECOMMENDED_POLICY.reviewThreshold), testAtChosen: at(test, best), curve: candidates.map((t) => ({ threshold: t, train: at(train, t), test: at(test, t) })) };
}

function calibration(outcomes: Outcome[]) {
  return Object.fromEntries((['low', 'medium', 'high'] as const).map((level) => {
    const list = outcomes.filter((o) => o.confidence?.level === level);
    const correct = list.filter((o) => o.flagged === (o.label === 'malicious')).length;
    return [level, { n: list.length, correct, accuracy: rate(correct, list.length) }];
  }));
}

async function main() {
  const recording = JSON.parse(await readFile(RECORDING, 'utf8')) as Recording;
  const all = buildScenarios();
  const problems = all.filter((scenario) => scenario.events.filter((event) => 'request' in event && event.target).length !== 1).map((scenario) => scenario.id);
  if (problems.length || new Set(all.map((scenario) => scenario.id)).size !== all.length) throw new Error(`Invalid corpus: ${problems.join(', ') || 'duplicate ids'}`);
  const excluded: Record<string, number> = {};
  const scenarios = all.filter((scenario) => {
    const reason = admissible(scenario, recording);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    return !reason;
  });
  const layer1 = await runConfiguration(scenarios, recording, false);
  const full = await runConfiguration(scenarios, recording, true);
  const changed = full.filter((outcome, index) => outcome.flagged !== layer1[index].flagged).map((outcome, index) => ({ id: outcome.id, category: outcome.category, label: outcome.label, layer1: layer1[full.indexOf(outcome)].flagged, full: outcome.flagged })).slice(0, 50);
  const results = {
    corpus: { built: all.length, used: scenarios.length, excluded, malicious: scenarios.filter((s) => s.label === 'malicious').length, benign: scenarios.filter((s) => s.label === 'benign').length, evidenceRecordedAt: recording.recordedAt },
    policy: RECOMMENDED_POLICY,
    full: { overall: summarize(full), byCategory: byKey(full, (o) => o.category), byType: byKey(full, (o) => o.type) },
    layer1: { overall: summarize(layer1), byCategory: byKey(layer1, (o) => o.category) },
    ablation: { note: 'Layer 1 = correlation and chain analysis off. Rows list scenarios whose outcome differs between configurations.', changed },
    thresholds: thresholdStudy(full),
    confidenceCalibration: calibration(full),
    misses: full.filter((o) => o.label === 'malicious' && !o.flagged).map((o) => ({ id: o.id, category: o.category, score: o.score })),
    falseAlarms: full.filter((o) => o.label === 'benign' && o.flagged).map((o) => ({ id: o.id, category: o.category, score: o.score, signals: o.signals })),
  };
  const timing = { note: 'Wall time per evaluation including recorded-evidence replay; varies by machine and is excluded from the reproducibility hash.', p50Ms: quantile(full.map((o) => o.ms), 0.5), p95Ms: quantile(full.map((o) => o.ms), 0.95) };
  const digest = createHash('sha256').update(JSON.stringify(results)).digest('hex');
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'results.json'), `${JSON.stringify({ ...results, timing, resultsHash: digest }, null, 2)}\n`);
  await writeFile(join(OUT, 'outcomes.json'), `${JSON.stringify(full.map(({ ms: _ms, ...rest }) => rest), null, 1)}\n`);
  await writeFile(join(OUT, 'summary.md'), report(results, timing));
  console.log(`Scenarios used: ${scenarios.length} of ${all.length} (${Object.values(excluded).reduce((a, b) => a + b, 0)} excluded by recorded-fact rules)`);
  console.log(`Full CARD:  ${fmt(results.full.overall)}`);
  console.log(`Layer 1:    ${fmt(results.layer1.overall)}`);
  console.log(`Threshold chosen on train: ${results.thresholds.chosen}; test at default: ${fmt(results.thresholds.testAtDefault)}`);
  console.log(`Results hash: ${digest}`);
}

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] * 100) / 100;
}
const pct = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const fmt = (s: ReturnType<typeof summarize>) => `detection ${pct(s.detectionRate)}, false positives ${pct(s.falsePositiveRate)}, precision ${pct(s.precision)} (TP ${s.tp}, FP ${s.fp}, FN ${s.fn}, TN ${s.tn})`;

function report(results: Record<string, any>, timing: Record<string, any>) {
  const rows = (table: Record<string, any>) => Object.entries(table).map(([name, s]) => `| ${name} | ${s.n} | ${s.flagged} | ${name.startsWith('benign') ? pct(s.falsePositiveRate) : pct(s.detectionRate)} |`).join('\n');
  const layer1 = results.layer1.byCategory;
  const ablation = Object.entries(results.full.byCategory).filter(([name]) => layer1[name].flagged !== (results.full.byCategory as any)[name].flagged).map(([name, s]: [string, any]) => `| ${name} | ${layer1[name].flagged}/${s.n} | ${s.flagged}/${s.n} |`).join('\n');
  return `# CARD benchmark results

Corpus: ${results.corpus.used} scenarios used (${results.corpus.malicious} malicious, ${results.corpus.benign} benign) of ${results.corpus.built} built. Registry and DNS facts recorded ${results.corpus.evidenceRecordedAt.slice(0, 10)}. Policy: review ${results.policy.reviewThreshold}, deny ${results.policy.denyThreshold}. "Flagged" = held for review or denied.

Excluded by recorded-fact rules: ${Object.entries(results.corpus.excluded).map(([reason, count]) => `${count} × ${reason}`).join('; ') || 'none'}.

## Overall

| Configuration | Detection rate | False-positive rate | Precision | F1 |
|---|---|---|---|---|
| Full CARD (Layer 1 + 2) | ${pct(results.full.overall.detectionRate)} | ${pct(results.full.overall.falsePositiveRate)} | ${pct(results.full.overall.precision)} | ${pct(results.full.overall.f1)} |
| Layer 1 only | ${pct(results.layer1.overall.detectionRate)} | ${pct(results.layer1.overall.falsePositiveRate)} | ${pct(results.layer1.overall.precision)} | ${pct(results.layer1.overall.f1)} |

## By category (full CARD)

| Category | Scenarios | Flagged | Detection (attacks) / false-positive rate (benign) |
|---|---|---|---|
${rows(results.full.byCategory)}

## Layer 2 ablation (categories whose outcome changed)

| Category | Layer 1 flagged | Full flagged |
|---|---|---|
${ablation || '| none | | |'}

## Threshold selection

${results.thresholds.method} Chosen review threshold: ${results.thresholds.chosen}. Test split (${results.thresholds.testSize} scenarios) at the default 20: ${fmt(results.thresholds.testAtDefault)}. At the chosen threshold: ${fmt(results.thresholds.testAtChosen)}.

## Confidence calibration

| Confidence | Scenarios | Decision correct |
|---|---|---|
${Object.entries(results.confidenceCalibration).map(([level, s]: [string, any]) => `| ${level} | ${s.n} | ${pct(s.accuracy)} |`).join('\n')}

## Misses and false alarms

Missed attacks: ${results.misses.length}. False alarms: ${results.falseAlarms.length}. Both are listed in results.json.

Timing: median ${timing.p50Ms} ms, 95th percentile ${timing.p95Ms} ms per evaluation (${timing.note})

Results hash: see results.json. Re-running \`npm run benchmark\` on the same recording reproduces it.
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
