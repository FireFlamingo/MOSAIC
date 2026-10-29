import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';

/**
 * Human reviewer authentication. Only a person who knows the PIN can record verdicts, revoke rules or change
 * policy, so an agent that can call the local API cannot approve its own requests. The PIN is stored only as
 * a salted scrypt hash. First-time setup needs a one-time code printed in the terminal running CARD.
 */
interface ReviewerFile { name: string; salt: string; hash: string; createdAt: string }
interface Session { name: string; expires: number }

const COOKIE = 'card_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

const hashPin = (pin: string, salt: string) => scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex');
const validPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\S{6,64}$/.test(pin);
const validName = (name: unknown): name is string => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 60;

export class ReviewerAuth {
  private readonly file: string;
  private reviewer?: ReviewerFile;
  private sessions = new Map<string, Session>();
  private failures = 0;
  private lockedUntil = 0;
  /** One-time code required to choose the first PIN; printed to the server console only. */
  readonly setupCode?: string;

  constructor(dataDir: string, preset?: { name: string; pin: string }) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'reviewer.json');
    if (preset && !existsSync(this.file)) this.save(preset.name, preset.pin);
    if (existsSync(this.file)) this.reviewer = JSON.parse(readFileSync(this.file, 'utf8')) as ReviewerFile;
    else this.setupCode = `${randomInt(100, 1000)}-${randomInt(100, 1000)}`;
  }

  private save(name: string, pin: string) {
    const salt = randomBytes(16).toString('hex');
    this.reviewer = { name: name.trim(), salt, hash: hashPin(pin, salt), createdAt: new Date().toISOString() };
    writeFileSync(this.file, JSON.stringify(this.reviewer, null, 2), { mode: 0o600 });
  }

  private token(req: Request): string | undefined {
    const match = (req.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    return match?.slice(COOKIE.length + 1);
  }

  /** The signed-in reviewer's name, or undefined. */
  reviewerFor(req: Request): string | undefined {
    const token = this.token(req);
    const session = token ? this.sessions.get(token) : undefined;
    if (!session) return undefined;
    if (session.expires < Date.now()) {
      this.sessions.delete(token!);
      return undefined;
    }
    return session.name;
  }

  status(req: Request) {
    const name = this.reviewerFor(req);
    return { configured: Boolean(this.reviewer), unlocked: Boolean(name), ...(name ? { reviewer: name } : {}) };
  }

  private open(res: Response) {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { name: this.reviewer!.name, expires: Date.now() + SESSION_MS });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  }

  setup(req: Request, res: Response) {
    if (this.reviewer) return res.status(409).json({ error: 'A reviewer PIN is already set. Sign in instead.' });
    const { code, name, pin } = req.body ?? {};
    if (code !== this.setupCode) return res.status(403).json({ error: 'Setup code is wrong. It is printed in the terminal where CARD is running.' });
    if (!validName(name)) return res.status(400).json({ error: 'Enter your name (up to 60 characters).' });
    if (!validPin(pin)) return res.status(400).json({ error: 'The PIN must be 6 to 64 characters without spaces.' });
    this.save(name, pin);
    this.open(res);
    return res.json({ configured: true, unlocked: true, reviewer: this.reviewer!.name });
  }

  unlock(req: Request, res: Response) {
    if (!this.reviewer) return res.status(409).json({ error: 'No reviewer PIN is set yet.' });
    if (Date.now() < this.lockedUntil) return res.status(429).json({ error: 'Too many wrong PINs. Try again in a minute.' });
    const pin = req.body?.pin;
    const expected = Buffer.from(this.reviewer.hash, 'hex');
    const given = validPin(pin) ? Buffer.from(hashPin(pin, this.reviewer.salt), 'hex') : Buffer.alloc(expected.length);
    if (!validPin(pin) || !timingSafeEqual(given, expected)) {
      this.failures += 1;
      if (this.failures >= MAX_FAILURES) {
        this.failures = 0;
        this.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      return res.status(401).json({ error: 'Wrong PIN.' });
    }
    this.failures = 0;
    this.open(res);
    return res.json({ configured: true, unlocked: true, reviewer: this.reviewer.name });
  }

  lock(req: Request, res: Response) {
    const token = this.token(req);
    if (token) this.sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return res.json({ configured: Boolean(this.reviewer), unlocked: false });
  }

  /** Express guard for routes only a human reviewer may call. */
  require = (req: Request, res: Response, next: () => void) => {
    if (this.reviewerFor(req)) return next();
    return res.status(401).json({ error: 'Reviewer sign-in required. Only a person with the CARD PIN can do this.' });
  };
}
