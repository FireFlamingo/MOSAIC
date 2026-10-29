/**
 * Refreshes shared/reference/popular-packages.json, the reference list for the lookalike check.
 * Run with `npx tsx scripts/update-popular-packages.ts`. Needs network access.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../shared/reference/popular-packages.json', import.meta.url));
const LIMIT = 2_000;
const NPM_SOURCE = 'https://cdn.jsdelivr.net/npm/npm-high-impact@1.13.0/lib/top-download.js';
const PYPI_SOURCE = 'https://hugovk.dev/top-pypi-packages/top-pypi-packages-30-days.min.json';

async function text(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

const npmModule = await text(NPM_SOURCE);
const npm = [...npmModule.matchAll(/'([^']+)'/g)].map((match) => match[1]).slice(0, LIMIT);
const pypiData = JSON.parse(await text(PYPI_SOURCE)) as { last_update: string; rows: Array<{ project: string }> };
const pypi = pypiData.rows.map((row) => row.project).slice(0, LIMIT);
if (npm.length < LIMIT || pypi.length < LIMIT) throw new Error(`Unexpectedly short lists: npm ${npm.length}, pypi ${pypi.length}`);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  sources: {
    npm: { url: NPM_SOURCE, description: 'npm-high-impact (MIT): npm packages ranked by downloads' },
    pypi: { url: PYPI_SOURCE, description: `top-pypi-packages by Hugo van Kemenade: PyPI projects ranked by 30-day downloads (data ${pypiData.last_update})` },
  },
  npm,
  pypi,
})}\n`, 'utf8');
console.log(`Wrote ${npm.length} npm and ${pypi.length} PyPI names to ${OUT}`);
