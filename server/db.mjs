import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
const marker = 'zecpaid-v1';
const schema = `
CREATE TABLE IF NOT EXISTS project_identity(id INTEGER PRIMARY KEY, project TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_attempts(state TEXT PRIMARY KEY,browser TEXT NOT NULL,verifier TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(x_id TEXT PRIMARY KEY,username TEXT NOT NULL,name TEXT NOT NULL,avatar TEXT,updated BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,x_id TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS wallets(x_id TEXT PRIMARY KEY,address TEXT UNIQUE NOT NULL,secret TEXT NOT NULL,created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,owner TEXT NOT NULL,recipient TEXT NOT NULL,name TEXT NOT NULL,symbol TEXT NOT NULL,description TEXT NOT NULL,image TEXT NOT NULL,frozen INTEGER NOT NULL DEFAULT 0,created BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner);
CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,owner TEXT NOT NULL,serialized TEXT NOT NULL,message_hash TEXT NOT NULL,mint TEXT NOT NULL,last_height BIGINT NOT NULL,review TEXT NOT NULL,status TEXT NOT NULL,signature TEXT UNIQUE,signed TEXT,expires BIGINT NOT NULL,error TEXT,created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS nominations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,repo TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL,reason TEXT NOT NULL,created BIGINT NOT NULL);
`;
export async function openDatabase(filename) {
  const scope = new AsyncLocalStorage(); let query, tx, close;
  if (filename === undefined && process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL); url.searchParams.set('sslmode', 'verify-full');
    const pool = new pg.Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, allowExitOnIdle: true });
    pool.on('error', () => console.error('ZecPaid database connection interrupted.'));
    if (process.env.VERCEL) attachDatabasePool(pool);
    query = (sql, args = []) => (scope.getStore() || pool).query(sql, args);
    const exists = await query("SELECT to_regclass('public.project_identity') AS name");
    if (exists.rows[0].name && (await query('SELECT project FROM project_identity WHERE id=1')).rows[0]?.project !== marker) { await pool.end(); throw Error('This database does not belong to ZecPaid.'); }
    await query(schema);
    tx = async fn => {
      if (scope.getStore()) return fn();
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('zecpaid-v1'))"); const r = await scope.run(client, fn); await client.query('COMMIT'); return r; }
      catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    };
    close = () => pool.end();
  } else {
    if (process.env.VERCEL) throw Error('ZecPaid needs its own production database.');
    filename ??= resolve('data/zecpaid.sqlite');
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_identity'").get() && db.prepare('SELECT project FROM project_identity WHERE id=1').get()?.project !== marker) { db.close(); throw Error('This database does not belong to ZecPaid.'); }
    db.exec(schema);
    let tail = Promise.resolve();
    const serial = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
    query = (sql, args = []) => {
      const execute = () => { const s = db.prepare(sql), p = Object.fromEntries(args.map((v, i) => [`$${i + 1}`, v])); if (s.columns().length) { const rows = s.all(p); return { rows, rowCount: rows.length }; } return { rows: [], rowCount: Number(s.run(p).changes) }; };
      return scope.getStore() ? Promise.resolve().then(execute) : serial(execute);
    };
    tx = fn => scope.getStore() ? fn() : serial(async () => { db.exec('BEGIN IMMEDIATE'); try { const v = await scope.run(true, fn); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } });
    close = async () => { await tail; db.close(); };
  }
  await query('INSERT INTO project_identity(id,project) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [marker]);
  return { query, tx, close, get: async (sql, ...p) => (await query(sql, p)).rows[0], all: async (sql, ...p) => (await query(sql, p)).rows, run: async (sql, ...p) => (await query(sql, p)).rowCount };
}
