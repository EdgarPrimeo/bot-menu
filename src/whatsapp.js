// Connexion WhatsApp via le pont Go « wa-bridge » (bibliothèque whatsmeow), lancé comme processus enfant.
// Échanges en lignes JSON : événements sur sa sortie, commandes d'envoi sur son entrée.
// Le pont filtre déjà la liste blanche ; on revérifie ici (double contrôle).
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import qrcodeTerminal from 'qrcode-terminal';
import { config, findContactByNumber, p } from './config.js';
import { log } from './log.js';

const BRIDGE_BIN = p('wa-bridge', 'wa-bridge');
const SESSION_DIR = p('session');

let child = null;
let connected = false;
let loggedOut = false;
let restarts = 0;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

export const isConnected = () => connected;
export const jidForNumber = (number) => `${number}@s.whatsapp.net`;

function handleEvent(ev, h) {
  switch (ev.type) {
    case 'qr':
      qrcodeTerminal.generate(ev.code, { small: true });
      h.onQr(ev.code);
      break;
    case 'pairing_code':
      log.info('whatsapp.pairing_code_issued');
      h.onPairingCode(ev.code);
      break;
    case 'pair_success':
      log.info('whatsapp.pair_success');
      break;
    case 'connected':
      connected = true;
      restarts = 0;
      log.info('whatsapp.open');
      h.onOpen();
      break;
    case 'disconnected':
      connected = false;
      log.warn('whatsapp.disconnected');
      break;
    case 'logged_out':
      connected = false;
      loggedOut = true;
      log.warn('whatsapp.logged_out', { reason: ev.reason });
      h.onLoggedOut(ev.reason);
      break;
    case 'message': {
      const contact = findContactByNumber(String(ev.number));
      if (!contact) { log.warn('whatsapp.unexpected_sender'); break; } // ne devrait pas arriver : le pont filtre déjà
      if (ev.kind === 'text' && ev.text) h.onMessage({ contact, jid: ev.chat, text: String(ev.text).slice(0, 4000) });
      else h.onNonText({ contact, jid: ev.chat });
      break;
    }
    case 'ignored':
      log.info('whatsapp.ignored_unknown_sender');
      break;
    case 'send_result': {
      const w = pending.get(ev.id);
      if (!w) break;
      pending.delete(ev.id);
      clearTimeout(w.timer);
      ev.ok ? w.resolve() : w.reject(new Error(ev.error || 'envoi refusé'));
      break;
    }
    case 'log':
      log.warn('bridge', { level: ev.level, msg: ev.msg });
      break;
    case 'passkey_required':
    case 'pair_error':
    case 'pair_timeout':
    case 'pair_giveup':
    case 'temporary_ban':
    case 'client_outdated':
    case 'stream_replaced':
    case 'connect_failure':
    case 'fatal':
      log.warn(`whatsapp.${ev.type}`, { info: ev.error || ev.reason || ev.attempt });
      h.onNotice(ev);
      break;
  }
}

export async function startWhatsApp(h) {
  if (!fs.existsSync(BRIDGE_BIN)) throw new Error('wa-bridge introuvable : compile-le (voir wa-bridge/README)');
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SESSION_DIR, 0o700);

  const env = {
    HOME: process.env.HOME, PATH: '/usr/bin:/bin', TZ: process.env.TZ || 'Europe/Paris',
    WA_ALLOWED_NUMBERS: config.contacts.map((c) => c.number).join(','),
    WA_PAIRING_NUMBER: config.pairingNumber || '',
    WA_DB_PATH: p('session', 'wa.db'),
  };
  child = spawn(BRIDGE_BIN, [], { cwd: p(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {}); // ignoré (peut contenir des détails techniques non expurgés)

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    try { handleEvent(ev, h); } catch (e) { log.error('whatsapp.event_handler', e); }
  });

  child.on('exit', (code) => {
    connected = false;
    for (const [, w] of pending) { clearTimeout(w.timer); w.reject(new Error('pont WhatsApp arrêté')); }
    pending.clear();
    log.warn('whatsapp.bridge_exit', { code });
    if (loggedOut) return; // il faudra relier à nouveau : on ne relance pas en boucle
    const delay = Math.min(60000, 5000 * 2 ** restarts++);
    setTimeout(() => startWhatsApp(h).catch((e) => log.error('whatsapp.restart', e)), delay);
  });
}

export function sendText(jid, text) {
  return new Promise((resolve, reject) => {
    if (!child || !connected) return reject(new Error('WhatsApp non connecté'));
    const id = String(nextId++);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("délai d'envoi dépassé")); }, 40000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ cmd: 'send', id, to: jid, text }) + '\n');
  });
}

export function stopWhatsApp() {
  if (child) child.kill('SIGTERM');
}
