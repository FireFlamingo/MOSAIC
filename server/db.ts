import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS evaluations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    body TEXT NOT NULL,
    review TEXT
  );
  CREATE INDEX IF NOT EXISTS evaluations_session ON evaluations (session_id, seq);
  CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS evidence_cache (key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS observations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS observations_session ON observations (session_id, seq);
`;

export type Row = Record<string, string | number | null>;

/** Thin wrapper over node:sqlite. All writes for one store change run inside a single transaction. */
export class Database {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'card.db'));
    this.db.exec(SCHEMA);
  }
  all(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  get(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  run(sql: string, ...params: Array<string | number | null>) {
    this.db.prepare(sql).run(...params);
  }
  transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}
