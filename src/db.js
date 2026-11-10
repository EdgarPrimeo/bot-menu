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
  -- Répertoire des plats déjà faits : sert à reproposer nos classiques et à suivre ce qu'on mange.
  CREATE TABLE IF NOT EXISTS dishes (
    name TEXT PRIMARY KEY COLLATE NOCASE, times INTEGER NOT NULL DEFAULT 0, last_day TEXT, added TEXT NOT NULL);
  -- Carnet de notes en texte libre (envies, plats mangés, goûts…) : Claude les lit et en tient compte.
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL, day TEXT NOT NULL, ts INTEGER NOT NULL);
`);

const now = () => Date.now();

// Premier démarrage : on pré-remplit le répertoire avec la liste de départ (plats-initiaux.json).
if (!db.prepare('SELECT 1 FROM kv WHERE key = ?').get('dishes_seeded')) {
  let seed = [];
  try { seed = JSON.parse(fs.readFileSync(p('plats-initiaux.json'), 'utf8')); } catch { /* pas de liste */ }
  const ins = db.prepare("INSERT OR IGNORE INTO dishes (name, times, last_day, added) VALUES (?, 1, NULL, 'liste initiale')");
  for (const name of seed) if (typeof name === 'string' && name.trim()) ins.run(name.trim());
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('dishes_seeded', '1');
}

// Un plat choisi : +1 dans le répertoire (créé s'il est nouveau).
export function recordDish(name, day) {
  db.prepare(`INSERT INTO dishes (name, times, last_day, added) VALUES (?, 1, ?, ?)
              ON CONFLICT(name) DO UPDATE SET times = times + 1, last_day = excluded.last_day`).run(name, day, day);
}

// Le plat du soir a changé : on retire l'ancien choix du compteur (et du répertoire s'il n'avait jamais été fait).
export function unrecordDish(name) {
  db.prepare('UPDATE dishes SET times = times - 1 WHERE name = ? AND times > 0').run(name);
  db.prepare("DELETE FROM dishes WHERE name = ? AND times = 0 AND added <> 'liste initiale'").run(name);
}

export function listDishes(limit = 80) {
  return db.prepare('SELECT name, times, last_day FROM dishes ORDER BY times DESC, last_day DESC, name LIMIT ?').all(limit);
}

// ---------- Carnet de notes (texte libre) ----------

const MAX_NOTES = 200;

const isoDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Ajoute une note (une ligne, 200 caractères max). Renvoie la note, ou null si doublon / texte vide.
export function addNote(text, source) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t) return null;
  if (db.prepare('SELECT 1 FROM notes WHERE text = ? COLLATE NOCASE').get(t)) return null;
  const day = isoDay();
  const id = Number(db.prepare('INSERT INTO notes (text, source, day, ts) VALUES (?,?,?,?)').run(t, source, day, now()).lastInsertRowid);
  // Plafond : on ne garde que les plus récentes.
  db.prepare('DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY ts DESC, id DESC LIMIT ?)').run(MAX_NOTES);
  return { id, text: t, source, day };
}

export function deleteNote(id) {
  return db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0;
}

// Les plus récentes en premier (pour /note et pour Claude, qui juge lui-même de l'âge d'une note grâce à sa date).
export function listNotes(limit = 60) {
  return db.prepare('SELECT id, text, source, day FROM notes ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
}

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
