import { dirname, isAbsolute, join } from 'node:path';
import type { ArtifactRequest } from '../shared/types.js';

/** One artifact a shell command would install or fetch, ready to send to CARD (session added later). */
export interface Extracted { request: Omit<ArtifactRequest, 'sessionId'>; label: string }
export type ReadFile = (path: string) => string | undefined;

const MAX_ARTIFACTS = 30;

/** Splits on unquoted && || ; | and newlines. Pipes are kept as separators so each program is parsed on its own. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { segments.push(current); current = ''; i += 1; continue; }
    if (char === ';' || char === '|' || char === '\n' || char === '\r') { segments.push(current); current = ''; continue; }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Shell-style words with single/double quotes removed. Good enough for command lines agents write; not a full shell. */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Removes wrappers that do not change what runs: sudo, env assignments, PowerShell's call operator, cmd /c. */
function unwrap(tokens: string[]): string[] {
  let rest = [...tokens];
  for (;;) {
    const head = rest[0]?.toLowerCase();
    if (!head) return rest;
    if (head === 'sudo' || head === 'time' || head === '&' || head === 'command' || head === 'exec') rest = rest.slice(1);
    else if (head === 'env' || /^[a-z_][a-z0-9_]*=/i.test(rest[0])) rest = rest.slice(1);
    else if ((head === 'cmd' || head === 'cmd.exe') && rest[1]?.toLowerCase() === '/c') rest = rest.slice(2);
    else return rest;
  }
}

const program = (token: string) => token.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

const NPM_INSTALL = new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'ci']);
const NPM_VALUE_FLAGS = new Set(['--registry', '--prefix', '--workspace', '-w', '--tag', '--cache', '--omit', '--include', '--userconfig', '--filter', '-C', '--dir', '--cwd']);
const PIP_VALUE_FLAGS = new Set(['-c', '--constraint', '--target', '-t', '--find-links', '-f', '--prefix', '--root', '--src', '--python', '-p', '--platform', '--abi', '--implementation', '--trusted-host', '--cache-dir', '--log', '--progress-bar']);

const urlArtifact = (url: string, label: string, content?: string): Extracted => ({ request: { type: 'url', name: url, source: url, ...(content ? { content } : {}) }, label });
const npmArtifact = (name: string, label: string): Extracted => ({ request: { type: 'package', ecosystem: 'npm', name }, label });
const pypiArtifact = (name: string, label: string): Extracted => ({ request: { type: 'package', ecosystem: 'pypi', name }, label });

/** Turns one npm-style argument into an artifact, a URL, or nothing (local paths and workspaces). */
function npmSpec(raw: string, label: string): Extracted | undefined {
  let spec = raw.trim();
  if (!spec) return undefined;
  if (/^https?:\/\//i.test(spec)) return urlArtifact(spec, label);
  if (/^git\+|^git:|\.git$/i.test(spec)) return urlArtifact(spec.replace(/^git\+/, ''), label);
  if (/^github:/i.test(spec)) return urlArtifact(`https://github.com/${spec.slice(7).replace(/#.*$/, '')}`, label);
  if (/^(\.|\/|~|[a-z]:\\|file:|link:|workspace:|portal:|patch:)/i.test(spec) || /\.(tgz|tar\.gz)$/i.test(spec)) return undefined;
  const alias = spec.indexOf('@npm:');
  if (alias > 0) spec = spec.slice(alias + 5);
  if (!spec.startsWith('@') && /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return urlArtifact(`https://github.com/${spec.replace(/#.*$/, '')}`, label);
  return npmArtifact(spec, label);
}

function pipSpec(raw: string, label: string): Extracted | undefined {
  const spec = raw.trim();
  if (!spec || spec === '.' || /^(\.|\/|~|[a-z]:\\|file:)/i.test(spec) || /\.(whl|tar\.gz|zip)$/i.test(spec)) return undefined;
  if (/^git\+/i.test(spec)) return urlArtifact(spec.replace(/^git\+/, '').replace(/@[^@/]*$/, ''), label);
  if (/^https?:\/\//i.test(spec)) return urlArtifact(spec, label);
  if (spec.includes(' @ ')) return undefined;
  const name = spec.split(/[<>=!~;\[\s@]/)[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  const exact = /==\s*([A-Za-z0-9._+-]+)/.exec(spec)?.[1];
  return pypiArtifact(exact ? `${name}==${exact}` : name, label);
}

function requirements(path: string, cwd: string, readFile: ReadFile, label: string, seen = new Set<string>()): Extracted[] {
  const full = isAbsolute(path) ? path : join(cwd, path);
  if (seen.has(full)) return [];
  seen.add(full);
  const text = readFile(full);
  if (text === undefined) return [];
  const out: Extracted[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const nested = /^(?:-r|--requirement)\s+(.+)$/.exec(line);
    if (nested) { out.push(...requirements(nested[1], dirname(full), readFile, label, seen)); continue; }
    const index = /^(?:-i|--index-url|--extra-index-url)\s+(\S+)/.exec(line);
    if (index) { out.push(urlArtifact(index[1], `${label} (package index)`)); continue; }
    if (line.startsWith('-')) continue;
    const found = pipSpec(line, label);
    if (found) out.push(found);
  }
  return out;
}

function manifestDependencies(cwd: string, readFile: ReadFile, label: string): Extracted[] {
  const text = readFile(join(cwd, 'package.json'));
  if (!text) return [];
  try {
    const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    const out: Extracted[] = [];
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(manifest[group] ?? {})) {
        const found = npmSpec(/^(npm:|https?:|git|github:|file:|link:|workspace:)/.test(range) ? range : name, `${label} (from package.json)`);
        if (found) out.push(found);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Positional arguments after the verb, skipping flags and the values of flags that take one. */
function positional(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueFlags.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function fromSegment(segment: string, whole: string, cwd: string, readFile: ReadFile): Extracted[] {
  const tokens = unwrap(tokenize(segment));
  if (!tokens.length) return [];
  const name = program(tokens[0]);
  let args = tokens.slice(1);
  const label = segment.length > 160 ? `${segment.slice(0, 157)}…` : segment;

  // python -m pip ... / py -m pip ...
  if (/^(python[\d.]*|py)$/.test(name)) {
    const module = args.indexOf('-m');
    if (module < 0 || !/^pip[\d.]*$/.test(args[module + 1] ?? '')) return [];
    return fromSegment(['pip', ...args.slice(module + 2)].join(' '), whole, cwd, readFile).map((item) => ({ ...item, label }));
  }

  if (['npm', 'pnpm', 'yarn', 'bun', 'cnpm'].includes(name)) {
    if (name === 'yarn' && args[0] === 'global') args = args.slice(1);
    const verb = args[0];
    if (name === 'npm' && (verb === 'exec' || verb === 'x')) return npxArtifacts(args.slice(1), label);
    if ((name === 'pnpm' || name === 'yarn') && verb === 'dlx') return npxArtifacts(args.slice(1), label);
    if (name === 'bun' && verb === 'x') return npxArtifacts(args.slice(1), label);
    const bareYarn = name === 'yarn' && (verb === undefined || verb.startsWith('-'));
    if (!bareYarn && !(verb && (NPM_INSTALL.has(verb) || (name !== 'npm' && verb === 'add')))) return [];
    // A custom registry decides where every package comes from, so it is checked as a URL in its own right.
    const registries = args.flatMap((arg, index) => arg === '--registry' ? [args[index + 1]] : arg.startsWith('--registry=') ? [arg.slice(11)] : [])
      .filter((url): url is string => Boolean(url) && /^https?:\/\//i.test(url)).map((url) => urlArtifact(url, `${label} (custom registry)`));
    const specs = positional(bareYarn ? args : args.slice(1), NPM_VALUE_FLAGS);
    if (!specs.length) return [...registries, ...manifestDependencies(cwd, readFile, label)];
    return [...registries, ...specs.map((spec) => npmSpec(spec, label)).filter((item): item is Extracted => Boolean(item))];
  }
  if (name === 'npx' || name === 'bunx') return npxArtifacts(args, label);

  if (/^pip[\d.]*$/.test(name) || (name === 'uv' && args[0] === 'pip')) {
    if (name === 'uv') args = args.slice(1);
    if (args[0] !== 'install' && args[0] !== 'download') return [];
    return pipArtifacts(args.slice(1), cwd, readFile, label);
  }
  if ((name === 'uv' || name === 'poetry' || name === 'pdm') && args[0] === 'add') return pipArtifacts(args.slice(1), cwd, readFile, label);
  if (name === 'pipx' && (args[0] === 'install' || args[0] === 'run')) return pipArtifacts(args.slice(1, 2), cwd, readFile, label);
  if (name === 'cargo' && args[0] === 'add') {
    return positional(args.slice(1), new Set(['--path', '--git', '--registry', '--package', '-p', '--rename', '--features', '-F', '--manifest-path'])).map((spec) => ({ request: { type: 'package' as const, name: spec.split('@')[0] }, label }));
  }

  const fetchers = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer']);
  if (fetchers.has(name) || (name === 'git' && args[0] === 'clone')) {
    // The whole command line is the content, so "download | sh" patterns are scored on the fetch itself.
    return args.filter((arg) => /^(https?|git|ssh):\/\//i.test(arg) || /^git@[^:]+:/.test(arg))
      .map((url) => urlArtifact(url.startsWith('git@') ? `https://${url.slice(4).replace(':', '/')}` : url, label, whole));
  }
  return [];
}

function npxArtifacts(args: string[], label: string): Extracted[] {
  const packageFlag = args.findIndex((arg) => arg === '-p' || arg === '--package');
  if (packageFlag >= 0 && args[packageFlag + 1]) return [npmSpec(args[packageFlag + 1], label)].filter((item): item is Extracted => Boolean(item));
  const inline = args.find((arg) => arg.startsWith('--package='));
  if (inline) return [npmSpec(inline.slice(10), label)].filter((item): item is Extracted => Boolean(item));
  const first = args.find((arg) => !arg.startsWith('-'));
  const found = first ? npmSpec(first, label) : undefined;
  return found ? [found] : [];
}

function pipArtifacts(args: string[], cwd: string, readFile: ReadFile, label: string): Extracted[] {
  const out: Extracted[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-r' || arg === '--requirement') { out.push(...requirements(args[i + 1] ?? '', cwd, readFile, label)); i += 1; continue; }
    if (arg.startsWith('--requirement=')) { out.push(...requirements(arg.slice(14), cwd, readFile, label)); continue; }
    if (arg === '-i' || arg === '--index-url' || arg === '--extra-index-url') { if (args[i + 1]) out.push(urlArtifact(args[i + 1], `${label} (package index)`)); i += 1; continue; }
    if (arg === '-e' || arg === '--editable') { const target = args[i + 1]; if (target && /^git\+|^https?:/.test(target)) out.push(...[pipSpec(target, label)].filter((item): item is Extracted => Boolean(item))); i += 1; continue; }
    if (arg.startsWith('-')) { if (!arg.includes('=') && PIP_VALUE_FLAGS.has(arg)) i += 1; continue; }
    const found = pipSpec(arg, label);
    if (found) out.push(found);
  }
  return out;
}

/** Every package or URL a shell command would install or fetch. */
export function extractFromCommand(command: string, cwd: string, readFile: ReadFile): Extracted[] {
  const seen = new Set<string>();
  const out: Extracted[] = [];
  for (const segment of splitSegments(command)) {
    for (const item of fromSegment(segment, command, cwd, readFile)) {
      const key = `${item.request.type}|${item.request.ecosystem ?? ''}|${item.request.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= MAX_ARTIFACTS) return out;
    }
  }
  return out;
}
