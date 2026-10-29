/**
 * Installs CARD into a workspace for Claude Code or Codex.
 *   npm run card -- install <claude|codex> --workspace <dir> [--url http://127.0.0.1:4318]
 *   npm run card -- uninstall <claude|codex> --workspace <dir>
 *   npm run card -- status --workspace <dir>
 *   npm run card -- proxy [--port 4873] [--url <CARD url>]          (npm + PyPI registry proxy)
 *   npm run card -- mcp-add <claude|codex> --workspace <dir> --name <server> -- <server command...>
 *   install ... --registry-proxy   also routes the workspace's npm (and Claude Code's pip) through the proxy
 * Writes project-level hook configuration only; user-level agent settings are never touched.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'dist-adapters', 'card-hook.mjs');
const MCP_BUNDLE = join(ROOT, 'dist-adapters', 'card-mcp-proxy.mjs');
type Agent = 'claude' | 'codex';

interface HookCommand { type: 'command'; command: string; timeout: number; statusMessage?: string }
interface MatcherGroup { matcher?: string; hooks: HookCommand[] }
type HookConfig = { hooks?: Record<string, MatcherGroup[]>; [key: string]: unknown };

const MATCHERS: Record<Agent, { pre: string; post: string }> = {
  claude: { pre: 'Bash|PowerShell|Read|WebFetch|Write|Edit|MultiEdit|NotebookEdit|mcp__.*', post: 'Bash|PowerShell|Read|WebFetch|mcp__.*' },
  codex: { pre: 'Bash|apply_patch|mcp__.*', post: 'Bash|mcp__.*' },
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const configPath = (agent: Agent, workspace: string) => (agent === 'claude' ? join(workspace, '.claude', 'settings.json') : join(workspace, '.codex', 'hooks.json'));
const isCardHook = (hook: HookCommand) => hook.command.includes('card-hook.mjs');

function read(file: string): HookConfig {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as HookConfig;
}

/** Removes CARD's entries and leaves every other hook the user configured as it was. */
function withoutCard(config: HookConfig): HookConfig {
  const hooks: Record<string, MatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const kept = groups.map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isCardHook(hook)) })).filter((group) => group.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = config;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

async function bundle() {
  const common = { bundle: true, platform: 'node' as const, format: 'esm' as const, target: 'node22', logLevel: 'warning' as const };
  await build({ ...common, entryPoints: [join(ROOT, 'adapters', 'hook.ts')], outfile: BUNDLE });
  await build({ ...common, entryPoints: [join(ROOT, 'adapters', 'mcp-proxy.ts')], outfile: MCP_BUNDLE });
}

/** npm reads the workspace .npmrc; replace-registry-host makes lockfile downloads go through the proxy too. */
function routeRegistry(agent: Agent, workspace: string, config: HookConfig, proxyUrl: string) {
  const npmrc = join(workspace, '.npmrc');
  const kept = existsSync(npmrc) ? readFileSync(npmrc, 'utf8').split(/\r?\n/).filter((line) => line.trim() && !/^(registry|replace-registry-host)\s*=/.test(line)) : [];
  writeFileSync(npmrc, `${[...kept, `registry=${proxyUrl}/`, 'replace-registry-host=always'].join('\n')}\n`);
  if (agent === 'claude') config.env = { ...(config.env as Record<string, string> | undefined), PIP_INDEX_URL: `${proxyUrl}/simple/`, UV_DEFAULT_INDEX: `${proxyUrl}/simple/` };
  console.log(`Routed npm${agent === 'claude' ? ' and pip' : ''} in ${workspace} through ${proxyUrl}. Start it with: npm run card -- proxy`);
}

async function install(agent: Agent, workspace: string, url: string) {
  await bundle();
  const file = configPath(agent, workspace);
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(`${file}.card-backup`)) copyFileSync(file, `${file}.card-backup`);
  const base = withoutCard(read(file));
  const command = `node "${BUNDLE.replace(/\\/g, '/')}" ${agent} --url=${url}`;
  const hook = (timeout: number): HookCommand => ({ type: 'command', command, timeout, ...(agent === 'codex' ? { statusMessage: 'Checking with CARD' } : {}) });
  const add = (event: string, group: MatcherGroup) => { base.hooks ??= {}; (base.hooks[event] ??= []).push(group); };
  // Waiting for a human takes up to 120 s, so the hook's own limit is higher than that.
  add('SessionStart', { hooks: [hook(60)] });
  add('UserPromptSubmit', { hooks: [hook(150)] });
  add('PreToolUse', { matcher: MATCHERS[agent].pre, hooks: [hook(150)] });
  add('PostToolUse', { matcher: MATCHERS[agent].post, hooks: [hook(30)] });
  if (process.argv.includes('--registry-proxy')) routeRegistry(agent, workspace, base, (option('proxy-url') ?? 'http://127.0.0.1:4873').replace(/\/$/, ''));
  writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`);
  console.log(`Installed CARD for ${agent} in ${file}`);
  if (agent === 'codex') {
    console.log('Codex runs project hooks only after you trust them: open Codex in this folder, accept "trust this project", then run /hooks and trust the CARD hooks.');
  }
}

function uninstall(agent: Agent, workspace: string) {
  const file = configPath(agent, workspace);
  if (!existsSync(file)) return console.log(`Nothing to remove: ${file} does not exist.`);
  writeFileSync(file, `${JSON.stringify(withoutCard(read(file)), null, 2)}\n`);
  console.log(`Removed CARD hooks from ${file}`);
}

async function status(workspace: string, url: string) {
  for (const agent of ['claude', 'codex'] as const) {
    const file = configPath(agent, workspace);
    const installed = Object.values(read(file).hooks ?? {}).some((groups) => groups.some((group) => group.hooks.some(isCardHook)));
    console.log(`${agent.padEnd(7)} ${installed ? 'installed' : 'not installed'} (${file})`);
  }
  console.log(`hook    ${existsSync(BUNDLE) ? 'built' : 'not built'} (${BUNDLE})`);
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    console.log(`CARD    ${response.ok ? 'running' : `answered ${response.status}`} at ${url}`);
  } catch {
    console.log(`CARD    not reachable at ${url}; agents will be blocked from installs and fetches until it runs`);
  }
}

const [command, agentArg] = process.argv.slice(2);
const workspace = resolve(option('workspace') ?? process.cwd());
const url = (option('url') ?? 'http://127.0.0.1:4318').replace(/\/$/, '');
if (command === 'install' || command === 'uninstall') {
  if (agentArg !== 'claude' && agentArg !== 'codex') throw new Error('Choose an agent: claude or codex');
  if (command === 'install') await install(agentArg, workspace, url);
  else uninstall(agentArg, workspace);
} else if (command === 'status') {
  await status(workspace, url);
} else if (command === 'proxy') {
  const { createRegistryProxy } = await import('../adapters/registry-proxy.js');
  const port = Number(option('port') ?? 4873);
  const deps = {
    fetch: globalThis.fetch, cardUrl: url, readFile: () => undefined, exists: () => false, listDir: () => [],
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)), now: () => Date.now(),
    reviewTimeoutMs: Number(process.env.CARD_REVIEW_TIMEOUT_S ?? 120) * 1000, pollMs: 1_000,
  };
  createRegistryProxy({ deps }).listen(port, '127.0.0.1', () => console.log(`CARD registry proxy on http://127.0.0.1:${port} (npm, and /simple/ for pip), checking with ${url}`));
} else if (command === 'mcp-add') {
  if (agentArg !== 'claude' && agentArg !== 'codex') throw new Error('Choose an agent: claude or codex');
  const name = option('name');
  const separator = process.argv.indexOf('--', 3);
  const server = separator > 0 ? process.argv.slice(separator + 1) : [];
  if (!name || !/^[\w-]+$/.test(name) || !server.length) throw new Error('Usage: mcp-add <agent> --workspace <dir> --name <server> -- <server command...>');
  await bundle();
  const args = [MCP_BUNDLE.replace(/\\/g, '/'), `--name=${name}`, `--url=${url}`, '--', ...server];
  if (agentArg === 'claude') {
    const file = join(workspace, '.mcp.json');
    const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    config.mcpServers = { ...(config.mcpServers ?? {}), [name]: { command: 'node', args } };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Added MCP server "${name}" behind CARD in ${file}`);
  } else {
    const file = join(workspace, '.codex', 'config.toml');
    mkdirSync(dirname(file), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const section = `[mcp_servers.${name}]`;
    const others = existing.split(/(?=^\[)/m).filter((part) => !part.startsWith(section)).join('').trimEnd();
    const toml = `${section}\ncommand = "node"\nargs = ${JSON.stringify(args)}\n`;
    writeFileSync(file, `${others ? `${others}\n\n` : ''}${toml}`);
    console.log(`Added MCP server "${name}" behind CARD in ${file}`);
  }
} else if (command === 'build') {
  await bundle();
  console.log(`Built ${BUNDLE} and ${MCP_BUNDLE}`);
} else {
  console.log('Usage: npm run card -- <install|uninstall> <claude|codex> --workspace <dir> [--url <CARD url>] [--registry-proxy] | status --workspace <dir> | proxy [--port 4873] | mcp-add <claude|codex> --workspace <dir> --name <server> -- <command...> | build');
}
