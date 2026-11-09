// Base SQLite (module intégré à Node) : historique, repas choisis, état du jour, compteur d'appels Claude.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { p } from './config.js';

fs.mkdirSync(p('data'), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(p('data', 'bot.db'));
fs.chmodSync(p('data', 'bot.db'), 0o600);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, contact INTEGER NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    author TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact, ts);
  CREATE TABLE IF NOT EXISTS meals (id INTEGER PRIMARY KEY, contact INTEGER NOT NULL, day TEXT NOT NULL, dish TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (contact INTEGER NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL,
    bot_replies INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (contact, day));
  CREATE TABLE IF NOT EXISTS claude_calls (ts INTEGER NOT NULL, ok INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY, contact INTEGER NOT NULL, proposed TEXT, sent TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const now = () => Date.now();

export function addMessage(contact, direction, author, text) {
  return Number(db.prepare('INSERT INTO messages (contact, direction, author, text, ts) VALUES (?,?,?,?,?)')
    .run(contact, direction, author, text, now()).lastInsertRowid);
}

export function deleteMessages(ids) {
  const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
  for (const id of ids) stmt.run(id);
}

export function lastMessages(contact, n) {
  return db.prepare('SELECT id, direction, author, text, ts FROM messages WHERE contact = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(contact, n).reverse();
}

// Un seul plat par soir : si le choix change, on remplace.
export function replaceMeal(contact, day, dish) {
  db.prepare('DELETE FROM meals WHERE contact = ? AND day = ?').run(contact, day);
  db.prepare('INSERT INTO meals (contact, day, dish, ts) VALUES (?,?,?,?)').run(contact, day, dish, now());
}

export function recentMeals(n = 10) {
  return db.prepare('SELECT day, dish FROM meals ORDER BY ts DESC LIMIT ?').all(n);
}

export function getSession(contact, day) {
  return db.prepare('SELECT status, bot_replies FROM sessions WHERE contact = ? AND day = ?').get(contact, day) || null;
}

export function setSessionStatus(contact, day, status) {
  db.prepare(`INSERT INTO sessions (contact, day, status) VALUES (?,?,?)
              ON CONFLICT(contact, day) DO UPDATE SET status = excluded.status`).run(contact, day, status);
}

export function incBotReplies(contact, day) {
  db.prepare('UPDATE sessions SET bot_replies = bot_replies + 1 WHERE contact = ? AND day = ?').run(contact, day);
}

export function recordClaudeCall(ok) {
  db.prepare('INSERT INTO claude_calls (ts, ok) VALUES (?,?)').run(now(), ok ? 1 : 0);
  db.prepare('DELETE FROM claude_calls WHERE ts < ?').run(now() - 7 * 24 * 3600 * 1000);
}

export function claudeCallsLastHour() {
  return db.prepare('SELECT COUNT(*) AS n FROM claude_calls WHERE ts > ?').get(now() - 3600 * 1000).n;
}

export function addCorrection(contact, proposed, sent) {
  db.prepare('INSERT INTO corrections (contact, proposed, sent, ts) VALUES (?,?,?,?)').run(contact, proposed, sent, now());
}

export function kvGet(key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}

export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
