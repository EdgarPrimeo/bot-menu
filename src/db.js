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
  -- Carnet de notes : envies du moment, plats mangés dont le bot n'a pas été informé, goûts durables.
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('envie','fait','gout')),
    text TEXT NOT NULL, source TEXT NOT NULL, day TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL);
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

// ---------- Carnet de notes ----------

export const NOTE_KINDS = ['envie', 'fait', 'gout'];
const MAX_NOTES = 300;
const WISH_DAYS = 21;  // une envie non réalisée n'est plus proposée au bout de 3 semaines
const DONE_DAYS = 30;  // « on a mangé ça » : on évite de le reproposer pendant un mois

const isoDay = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Ajoute une note (texte d'une ligne, 140 caractères max). Renvoie la note, ou null si doublon / texte vide.
export function addNote(kind, text, source, day = isoDay()) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!NOTE_KINDS.includes(kind) || !t) return null;
  if (db.prepare('SELECT 1 FROM notes WHERE kind = ? AND text = ? COLLATE NOCASE AND done = 0').get(kind, t)) return null;
  const id = Number(db.prepare('INSERT INTO notes (kind, text, source, day, ts) VALUES (?,?,?,?,?)')
    .run(kind, t, source, day, now()).lastInsertRowid);
  // Plafond : on ne garde que les plus récentes.
  db.prepare('DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY ts DESC, id DESC LIMIT ?)').run(MAX_NOTES);
  return { id, kind, text: t, source, day };
}

export function deleteNote(id) {
  return db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0;
}

// Toutes les notes (pour /notes), les plus récentes en premier.
export function listNotes(limit = 60) {
  return db.prepare('SELECT id, kind, text, source, day, done FROM notes ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
}

// Ce que Claude voit : envies encore actives, plats « faits » récents, goûts durables.
export function notesForPrompt() {
  const rows = (sql, ...args) => db.prepare(sql).all(...args);
  return {
    wishes: rows("SELECT text, day FROM notes WHERE kind = 'envie' AND done = 0 AND day >= ? ORDER BY ts DESC LIMIT 15", isoDay(-WISH_DAYS)),
    done: rows("SELECT text, day FROM notes WHERE kind = 'fait' AND day >= ? ORDER BY day DESC, ts DESC LIMIT 20", isoDay(-DONE_DAYS)),
    tastes: rows("SELECT text FROM notes WHERE kind = 'gout' ORDER BY ts DESC LIMIT 40"),
  };
}

// Un plat vient d'être choisi : les envies qui le citent sont réalisées.
export function markWishesDone(dish) {
  const needle = String(dish || '').trim().toLowerCase();
  if (needle.length < 3) return 0;
  let n = 0;
  const upd = db.prepare('UPDATE notes SET done = 1 WHERE id = ?');
  for (const w of db.prepare("SELECT id, text FROM notes WHERE kind = 'envie' AND done = 0").all()) {
    const t = w.text.toLowerCase();
    if (t.length >= 3 && (t.includes(needle) || needle.includes(t))) { upd.run(w.id); n += 1; }
  }
  return n;
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
