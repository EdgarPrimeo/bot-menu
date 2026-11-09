// Journal d'événements. Règle : JAMAIS de contenu de message ni de numéro ici, seulement des événements.
import fs from 'node:fs';
import { p } from './config.js';

fs.mkdirSync(p('logs'), { recursive: true, mode: 0o700 });
const stream = fs.createWriteStream(p('logs', 'bot.log'), { flags: 'a', mode: 0o600 });

function write(level, event, meta) {
  const line = `${new Date().toISOString()} ${level} ${event}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  stream.write(line + '\n');
  console.log(line);
}

export const log = {
  info: (event, meta) => write('INFO', event, meta),
  warn: (event, meta) => write('WARN', event, meta),
  // Pour les erreurs : uniquement le message d'erreur, tronqué, jamais l'objet complet.
  error: (event, err) => write('ERROR', event, { err: String(err?.message || err).slice(0, 200) }),
};
