// Chargement de la configuration : .env (secrets), config.json (réglages), allowlist.json (contacts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const p = (...parts) => path.join(ROOT, ...parts);

process.loadEnvFile(p('.env'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(p(file), 'utf8'));
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerId = Number(process.env.TELEGRAM_OWNER_ID);
if (!token || !Number.isSafeInteger(ownerId) || ownerId <= 0) {
  throw new Error('TELEGRAM_BOT_TOKEN ou TELEGRAM_OWNER_ID manquant/invalide dans .env');
}

const settings = readJson('config.json');
const allow = readJson('allowlist.json');

const contacts = (allow.contacts || []).map((c, i) => {
  const number = String(c.number || '').trim();
  if (!/^\d{8,15}$/.test(number)) {
    throw new Error(`allowlist.json : numéro invalide pour le contact #${i + 1} (chiffres uniquement, indicatif pays inclus, sans + ni espaces)`);
  }
  return { idx: i, name: String(c.name || `Contact ${i + 1}`), number, daily: c.daily === true };
});

// Optionnel : numéro du téléphone SECONDAIRE (celui du bot) pour relier WhatsApp par code au lieu du QR.
const pairingNumber = String(process.env.WA_PAIRING_NUMBER || '').trim();
if (pairingNumber && !/^\d{8,15}$/.test(pairingNumber)) {
  throw new Error('WA_PAIRING_NUMBER invalide dans .env (chiffres uniquement, indicatif pays inclus, sans + ni espaces)');
}

export const config = {
  telegramToken: token,
  ownerId,
  pairingNumber,
  contacts,
  dailyTime: settings.dailyTime ?? '15:30',
  dailyCatchupUntil: settings.dailyCatchupUntil ?? '19:00',
  conversationStart: settings.conversationStart ?? '11:00',
  conversationEnd: settings.conversationEnd ?? '22:30',
  dailyMessages: (Array.isArray(settings.dailyMessages) && settings.dailyMessages.length
    ? settings.dailyMessages : ["Coucou ! Qu'est-ce qu'on mange ce soir ?"]).map(String),
  model: settings.model ?? 'haiku',
  claudeTimeoutSec: settings.claudeTimeoutSec ?? 180,
  maxClaudeCallsPerHour: settings.maxClaudeCallsPerHour ?? 30,
  maxBotRepliesPerDay: settings.maxBotRepliesPerDay ?? 15,
  debounceSec: settings.debounceSec ?? 20,
  historySize: settings.historySize ?? 20,
  minFreeMemoryMb: settings.minFreeMemoryMb ?? 300,
  ownerName: settings.ownerName ?? 'moi',
};

export function readTextFile(file) {
  try { return fs.readFileSync(p(file), 'utf8').trim(); } catch { return ''; }
}

export function findContactByNumber(number) {
  return config.contacts.find((c) => c.number === number) || null;
}
