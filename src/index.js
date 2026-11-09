// Menu du soir : message quotidien sur WhatsApp, discussion repas pilotée par Claude, contrôle et reprise en main sur Telegram.
import { config, readTextFile } from './config.js';
import * as db from './db.js';
import { decide, ClaudeUnavailable } from './claude.js';
import { log } from './log.js';
import { bot, notify, sendQr, clearQr, kb } from './telegram.js';
import { startWhatsApp, stopWhatsApp, sendText, isConnected, jidForNumber } from './whatsapp.js';

const contactByIdx = (i) => config.contacts[Number(i)] || null;
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const isPaused = () => db.kvGet('paused') === '1';

const lastJid = new Map(); // idx -> dernier JID vu (gère les identifiants masqués de WhatsApp)
const jidOf = (c) => lastJid.get(c.idx) || jidForNumber(c.number);

// Règles du jour :
//  - le bot n'écoute Elsa qu'entre conversationStart (11h) et conversationEnd (22h30), et jamais en pause ;
//  - chaque message est trié par Claude : seul le repas de ce soir est traité, le reste est laissé passer en silence
//    (pas de réponse, pas de notification, et le message est effacé de la base) ;
//  - si tu as repris la main aujourd'hui, ses messages te sont transférés et le bot ne répond pas.
const inWindow = () => hm() >= config.conversationStart && hm() < config.conversationEnd;

function botState(c) {
  if (isPaused()) return 'paused';
  if (!inWindow()) return 'off_hours';
  const s = db.getSession(c.idx, today());
  if (s && (s.status === 'escalated' || s.status === 'owner')) return 'owner';
  if (s && s.bot_replies >= config.maxBotRepliesPerDay) return 'cap';
  return 'active';
}

// ---------- WhatsApp → bot ----------

const buffers = new Map(); // idx -> { items: [{id, text}], timer } : regroupe les messages envoyés à la suite (1 seul appel Claude)

function onMessage({ contact: c, jid, text }) {
  lastJid.set(c.idx, jid);
  const state = botState(c);
  log.info('whatsapp.message_in', { contact: c.idx, len: text.length, state });

  if (state === 'paused' || state === 'off_hours') return; // laissé passer, rien n'est conservé
  if (state === 'owner' || state === 'cap') {
    db.addMessage(c.idx, 'in', c.name, text);
    const why = state === 'cap' ? 'plafond de réponses du jour atteint' : 'tu as la main aujourd\'hui';
    notify(`💬 ${c.name} :\n${text}\n\n(Le bot ne répond pas : ${why}.)`, { keyboard: kb.forwarded(c.idx) });
    return;
  }
  const id = db.addMessage(c.idx, 'in', c.name, text);
  const buf = buffers.get(c.idx) || { items: [], timer: null };
  buf.items.push({ id, text });
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => { buffers.delete(c.idx); handleBatch(c, buf.items); }, config.debounceSec * 1000);
  buffers.set(c.idx, buf);
}

function onNonText({ contact: c, jid }) {
  lastJid.set(c.idx, jid);
  log.info('whatsapp.non_text_in', { contact: c.idx });
  // Signalé seulement pendant une discussion repas en cours (un vocal peut contenir sa réponse).
  if (botState(c) === 'active' && db.getSession(c.idx, today())) {
    notify(`📎 ${c.name} a envoyé une photo ou un vocal pendant la discussion repas. Le bot ne peut pas le lire.`, { silent: true, keyboard: kb.forwarded(c.idx) });
  }
}

// Message « Recette : … » pour Edgar : la recette, puis qui achète quoi.
async function notifyAgreed(c, d) {
  if (d.shopper === 'restaurant') {
    await notify(`🍽 ${c.name} est partante pour le restaurant ce soir.\n\nÀ toi de jouer : le bot ne lui répond plus aujourd'hui, c'est toi qui prends la main.`, { keyboard: kb.forwarded(c.idx) });
    return;
  }
  const parts = [`🍳 Recette : ${d.dish}`];
  if (d.recipe) parts.push(d.recipe);
  if (d.shopper === 'elsa') parts.push(`🛍 Pas besoin de faire les courses, ${c.name} s'en occupe.`);
  else if (d.shopper === 'none') parts.push('✅ Pas de courses nécessaires, on a tout.');
  else {
    parts.push(`🛒 Tes courses :\n${d.shopping || "(Claude n'a pas fourni de liste cette fois)"}`);
    if (d.shopper === 'both' && d.elsaBuys) parts.push(`🛍 ${c.name} prend :\n${d.elsaBuys}`);
  }
  await notify(parts.join('\n\n'));
}

// Répertoire des plats : +1 pour le plat choisi ; si le choix du soir change, l'ancien est retiré.
function recordCatalog(c, day, name) {
  if (!name) return;
  const key = `catalog:${day}:${c.idx}`;
  const prev = db.kvGet(key);
  if (prev && prev.toLowerCase() === name.toLowerCase()) return;
  if (prev) db.unrecordDish(prev);
  db.recordDish(name, day);
  db.kvSet(key, name);
}

async function handleBatch(c, items) {
  const day = today();
  const texts = items.map((x) => x.text);
  const ids = new Set(items.map((x) => x.id));
  const history = db.lastMessages(c.idx, config.historySize + items.length).filter((m) => !ids.has(m.id));
  let d;
  try {
    d = await decide({
      contactName: c.name, history, newMessages: texts, recentMeals: db.recentMeals(14),
      dishes: db.listDishes(), lastRestoProposal: db.kvGet('resto_proposed_day'),
    });
  } catch (e) {
    if (!(e instanceof ClaudeUnavailable)) log.error('batch.unexpected', e);
    await notify(`⚠️ Erreur : Claude indisponible (${String(e.message).slice(0, 80)}). Rien n'a été envoyé à ${c.name}.\n\nSon message :\n${texts.join('\n')}`, { keyboard: kb.forwarded(c.idx) });
    return;
  }

  if (d.action === 'ignore') {
    db.deleteMessages([...ids]); // hors sujet repas : on n'en garde aucune trace
    log.info('batch.ignored_off_topic', { contact: c.idx });
    return;
  }

  // Pendant l'appel, tu as pu reprendre la main ou mettre en pause : on vérifie à nouveau.
  const state = botState(c);
  if (state !== 'active') {
    await notify(`ℹ️ Réponse du bot abandonnée (${state === 'owner' ? 'tu as la main' : state}).`, { silent: true });
    return;
  }

  const received = texts.join('\n');
  if (!db.getSession(c.idx, day)) db.setSessionStatus(c.idx, day, 'open'); // Elsa a lancé le sujet elle-même
  try {
    if (d.action === 'reply' || d.action === 'agreed') {
      await sendText(jidOf(c), d.message);
      db.addMessage(c.idx, 'out', 'bot', d.message);
      db.incBotReplies(c.idx, day);
      log.info('whatsapp.message_out', { contact: c.idx, by: 'bot', action: d.action });
    }
  } catch (e) {
    log.error('whatsapp.send', e);
    db.setSessionStatus(c.idx, day, 'escalated');
    await notify(`⚠️ Erreur : envoi WhatsApp impossible, rien n'est parti.\n\n${c.name} : ${received}`, { keyboard: kb.forwarded(c.idx) });
    return;
  }

  switch (d.action) {
    case 'reply':
      if (d.proposedRestaurant) db.kvSet('resto_proposed_day', day);
      await notify(`💬 ${c.name} : ${received}\n🤖 : ${d.message}`, { silent: true, keyboard: kb.monitor(c.idx) });
      break;
    case 'agreed':
      db.replaceMeal(c.idx, day, d.dish);
      recordCatalog(c, day, d.catalog);
      // Restaurant : Edgar prend la main pour la soirée (choix du lieu, réservation…).
      db.setSessionStatus(c.idx, day, d.shopper === 'restaurant' ? 'owner' : 'agreed');
      await notify(`💬 ${c.name} : ${received}\n🤖 : ${d.message}`, { silent: true, keyboard: kb.monitor(c.idx) });
      await notifyAgreed(c, d);
      break;
    case 'none':
      await notify(`💬 ${c.name} : ${received}\n(pas de réponse nécessaire)`, { silent: true, keyboard: kb.monitor(c.idx) });
      break;
    case 'escalate':
      db.setSessionStatus(c.idx, day, 'escalated');
      await notify(`🙋 Message suspect ou demande d'engagement : le bot n'a pas répondu, à toi de voir.\n\n💬 ${c.name} : ${received}`, { keyboard: kb.forwarded(c.idx) });
      break;
  }
}

// ---------- Message quotidien ----------

async function sendDaily(c, { force = false } = {}) {
  const day = today();
  const key = `daily:${day}:${c.idx}`;
  if (!force && db.kvGet(key)) return false;
  if (!force && db.getSession(c.idx, day)) {
    // Elsa a déjà lancé le sujet aujourd'hui : pas besoin de lui demander.
    db.kvSet(key, 'skipped');
    log.info('daily.skipped_already_discussed', { contact: c.idx });
    return false;
  }
  // Ouverture variée, sans reprendre celle de la veille.
  const prev = db.kvGet('daily:last_text');
  const pool = config.dailyMessages.length > 1 ? config.dailyMessages.filter((m) => m !== prev) : config.dailyMessages;
  const text = pool[Math.floor(Math.random() * pool.length)];
  await sendText(jidOf(c), text);
  db.kvSet(key, '1');
  db.kvSet('daily:last_text', text);
  db.addMessage(c.idx, 'out', 'bot', text);
  if (!db.getSession(c.idx, day)) db.setSessionStatus(c.idx, day, 'open');
  log.info('daily.sent', { contact: c.idx });
  await notify(`📤 Message envoyé à ${c.name} : « ${text} »`, { silent: true });
  return true;
}

setInterval(async () => {
  if (!isConnected() || isPaused()) return;
  const t = hm();
  if (t < config.dailyTime || t >= config.dailyCatchupUntil) return;
  for (const c of config.contacts.filter((x) => x.daily)) {
    try { await sendDaily(c); } catch (e) { log.error('daily.send', e); }
  }
}, 30 * 1000);

// ---------- Telegram : commandes et boutons ----------

let compose = null; // { idx } en attente du texte à envoyer
let draft = null;   // { idx, text } en attente de confirmation

const HELP = [
  '🍝 Menu du soir — commandes :',
  '/statut — état du bot',
  '/envoyer — envoyer le message du jour maintenant',
  '/ecrire — écrire toi-même à la personne',
  '/pause — le bot ne répond plus (tout t\'est transféré)',
  '/reprendre — le bot répond à nouveau',
  '/gouts — voir le fichier de goûts',
  '/plats — derniers soirs et répertoire des plats déjà faits',
].join('\n');

bot.command(['start', 'aide'], (ctx) => ctx.reply(HELP));

bot.command('statut', (ctx) => {
  const lines = [
    `WhatsApp : ${isConnected() ? '🟢 connecté' : '🔴 déconnecté'}`,
    `Bot : ${isPaused() ? '⏸ en pause' : '▶️ actif'}`,
    `Appels Claude (dernière heure) : ${db.claudeCallsLastHour()}/${config.maxClaudeCallsPerHour}`,
    `Message du jour : ${config.dailyTime} (sauf si Elsa a déjà lancé le sujet)`,
    `Le bot écoute de ${config.conversationStart} à ${config.conversationEnd}`,
  ];
  for (const c of config.contacts) {
    const s = db.getSession(c.idx, today());
    lines.push(`${c.name} : ${s ? `${s.status}, ${s.bot_replies} réponse(s) du bot` : 'pas encore de discussion'}`);
  }
  return ctx.reply(lines.join('\n'));
});

bot.command('pause', (ctx) => { db.kvSet('paused', '1'); log.info('owner.pause'); return ctx.reply('⏸ Bot en pause : plus de message du jour ni de réponse automatique.'); });
bot.command('reprendre', (ctx) => { db.kvSet('paused', '0'); log.info('owner.resume'); return ctx.reply('▶️ Bot actif.'); });

bot.command('envoyer', async (ctx) => {
  if (isPaused()) return ctx.reply('⏸ Le bot est en pause. Tape /reprendre d\'abord.');
  for (const c of config.contacts.filter((x) => x.daily)) {
    try { await sendDaily(c, { force: true }); } catch (e) { log.error('daily.manual', e); await ctx.reply(`⚠️ Envoi impossible à ${c.name} (${e.message}).`); }
  }
});

bot.command('gouts', (ctx) => ctx.reply(readTextFile('gouts.md').slice(0, 3900) || '(gouts.md est vide)'));
bot.command('plats', (ctx) => {
  const recent = db.recentMeals(7);
  const rep = db.listDishes();
  const lines = ['🗓 Derniers soirs :', ...(recent.length ? recent.map((x) => `${x.day} : ${x.dish}`) : ['(aucun pour le moment)'])];
  lines.push('', `📚 Répertoire (${rep.length} plats) :`, ...rep.map((d) => `${d.name} — ${d.times} fois${d.last_day ? `, dernière ${d.last_day}` : ''}`));
  return ctx.reply(lines.join('\n').slice(0, 3900));
});

bot.command('ecrire', (ctx) => {
  const c = config.contacts[0];
  compose = { idx: c.idx };
  return ctx.reply(`✍️ Écris le message pour ${c.name} :`);
});

bot.callbackQuery(/^reply:(\d+)$/, async (ctx) => {
  const c = contactByIdx(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!c) return;
  compose = { idx: c.idx };
  db.setSessionStatus(c.idx, today(), 'owner');
  await ctx.reply(`✍️ Écris ta réponse pour ${c.name} (le bot ne répondra plus aujourd'hui, sauf si tu lui rends la main) :`);
});

bot.callbackQuery(/^takeover:(\d+)$/, async (ctx) => {
  const c = contactByIdx(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'Tu as la main.' });
  if (!c) return;
  db.setSessionStatus(c.idx, today(), 'owner');
  log.info('owner.takeover', { contact: c.idx });
  await ctx.reply(`✋ Tu as la main avec ${c.name} pour aujourd'hui. Ses messages te seront transférés.`, { reply_markup: kb.forwarded(c.idx) });
});

bot.callbackQuery(/^resume:(\d+)$/, async (ctx) => {
  const c = contactByIdx(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: 'Le bot reprend.' });
  if (!c) return;
  db.setSessionStatus(c.idx, today(), 'open');
  log.info('owner.handback', { contact: c.idx });
  await ctx.reply(`🤖 Le bot reprend la discussion avec ${c.name} à partir du prochain message.`);
});

bot.callbackQuery('send', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!draft) return ctx.reply('Plus rien à envoyer.');
  const c = contactByIdx(draft.idx);
  const text = draft.text;
  draft = null;
  try {
    await sendText(jidOf(c), text);
    db.addMessage(c.idx, 'out', 'owner', text);
    log.info('whatsapp.message_out', { contact: c.idx, by: 'owner' });
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply(`✅ Envoyé à ${c.name}.`);
  } catch (e) {
    log.error('owner.send', e);
    await ctx.reply(`⚠️ Envoi impossible (${e.message}). Rien n'est parti.`);
  }
});

bot.callbackQuery('cancel', async (ctx) => {
  draft = null; compose = null;
  await ctx.answerCallbackQuery({ text: 'Annulé.' });
  await ctx.editMessageReplyMarkup().catch(() => {});
});

bot.on('message:text', async (ctx) => {
  if (!compose) return ctx.reply(HELP);
  const c = contactByIdx(compose.idx);
  compose = null;
  draft = { idx: c.idx, text: ctx.message.text.slice(0, 2000) };
  await ctx.reply(`Envoyer à ${c.name} :\n\n${draft.text}`, { reply_markup: kb.confirm() });
});

// ---------- Démarrage ----------

async function main() {
  if (!config.contacts.length) throw new Error('allowlist.json ne contient aucun contact');
  // Premier lancement : le bot démarre EN PAUSE. Rien n'est envoyé tant que tu n'as pas tapé /reprendre.
  if (db.kvGet('paused') === null) db.kvSet('paused', '1');
  await bot.api.setMyCommands([
    { command: 'statut', description: 'État du bot' },
    { command: 'envoyer', description: 'Envoyer le message du jour maintenant' },
    { command: 'ecrire', description: 'Écrire toi-même à la personne' },
    { command: 'pause', description: 'Mettre le bot en pause' },
    { command: 'reprendre', description: 'Réactiver le bot' },
    { command: 'gouts', description: 'Voir les goûts' },
    { command: 'plats', description: 'Derniers soirs et répertoire des plats' },
  ]).catch((e) => log.error('telegram.commands', e));
  bot.start({ drop_pending_updates: true, onStart: () => log.info('telegram.started') }).catch((e) => { log.error('telegram.polling', e); process.exit(1); });

  await startWhatsApp({
    onQr: (qr) => sendQr(qr),
    onPairingCode: (code) => notify(
      `🔑 Code pour relier WhatsApp : ${code.match(/.{1,4}/g).join('-')}\n\nSur le téléphone du numéro secondaire : WhatsApp → Appareils connectés → Connecter un appareil → « Connecter avec un numéro de téléphone à la place », puis tape ce code. Il expire au bout de quelques minutes ; un nouveau code arrivera tout seul si besoin.`,
    ),
    onOpen: () => {
      clearQr();
      notify(`🟢 WhatsApp connecté.${isPaused() ? '\n⏸ Le bot est EN PAUSE : rien ne sera envoyé. Tape /reprendre quand tu es prêt.' : ''}`, { silent: true });
    },
    onLoggedOut: (reason) => notify(`🔴 WhatsApp a fermé la session du bot (${reason || 'raison inconnue'}). Pour relier à nouveau, relance le bot : un nouveau code arrivera ici.`),
    onNotice: (ev) => {
      const msgs = {
        passkey_required: "🔐 WhatsApp demande une clé d'accès (passkey) pour relier l'appareil, ce que le bot ne sait pas faire. Sur le téléphone secondaire : Réglages → Compte → Clés d'accès, supprime-la temporairement, puis relance le bot.",
        pair_timeout: `⌛ Code expiré sans liaison (tentative ${ev.attempt}/5). Un nouveau code arrive.`,
        pair_giveup: '🛑 5 tentatives de liaison sans succès : le bot arrête d\'en générer. Relance-le quand tu es prêt.',
        pair_error: `⚠️ Erreur de liaison : ${ev.error || '?'}`,
        temporary_ban: `⛔ WhatsApp a temporairement bloqué ce numéro (${ev.reason || '?'}). Le bot ne peut rien envoyer.`,
        client_outdated: '⚠️ WhatsApp juge la bibliothèque trop ancienne : il faut mettre à jour whatsmeow.',
        stream_replaced: '⚠️ La session du bot a été ouverte ailleurs (autre instance ?).',
        connect_failure: `⚠️ Connexion refusée par WhatsApp (${ev.reason || '?'}).`,
        fatal: `🛑 Le pont WhatsApp n'a pas pu démarrer (${ev.error || '?'}).`,
      };
      const text = msgs[ev.type];
      if (text) notify(text);
    },
    onMessage,
    onNonText,
  });
  log.info('bot.started', { contacts: config.contacts.length });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { log.info('bot.stopping'); stopWhatsApp(); await bot.stop().catch(() => {}); process.exit(0); });
}
process.on('unhandledRejection', (e) => log.error('unhandled', e));

main().catch((e) => { log.error('bot.fatal', e); process.exit(1); });
