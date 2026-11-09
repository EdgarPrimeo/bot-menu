// Bot Telegram de contrôle. Il n'obéit qu'à TELEGRAM_OWNER_ID, en conversation privée ; tout le reste est ignoré en silence.
// Les textes venant de WhatsApp sont envoyés en texte brut (pas de HTML/Markdown) pour qu'ils ne puissent rien formater ni piéger.
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import QRCode from 'qrcode';
import { config } from './config.js';
import { log } from './log.js';

export const bot = new Bot(config.telegramToken);
const owner = config.ownerId;

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== owner) return;
  if (ctx.chat && ctx.chat.type !== 'private') return;
  await next();
});

bot.catch((err) => log.error('telegram.handler', err.error || err));

export async function notify(text, { keyboard, silent = false } = {}) {
  try {
    return await bot.api.sendMessage(owner, text.slice(0, 4000), {
      reply_markup: keyboard,
      disable_notification: silent,
      link_preview_options: { is_disabled: true },
    });
  } catch (e) { log.error('telegram.notify', e); return null; }
}

let lastQrMessageId = null;
let lastQrAt = 0;
export async function sendQr(qr) {
  if (Date.now() - lastQrAt < 15000) return;
  lastQrAt = Date.now();
  try {
    const png = await QRCode.toBuffer(qr, { width: 420, margin: 2 });
    if (lastQrMessageId) await bot.api.deleteMessage(owner, lastQrMessageId).catch(() => {});
    const m = await bot.api.sendPhoto(owner, new InputFile(png, 'qr.png'), {
      caption: 'QR WhatsApp : sur le téléphone du numéro secondaire, ouvre WhatsApp → Appareils connectés → Connecter un appareil, puis scanne. (Il change toutes les ~20 s.)',
    });
    lastQrMessageId = m.message_id;
  } catch (e) { log.error('telegram.qr', e); }
}

export async function clearQr() {
  if (lastQrMessageId) await bot.api.deleteMessage(owner, lastQrMessageId).catch(() => {});
  lastQrMessageId = null;
}

export const kb = {
  forwarded: (idx) => new InlineKeyboard().text('✍️ Répondre', `reply:${idx}`).text('🤖 Rendre la main au bot', `resume:${idx}`),
  monitor: (idx) => new InlineKeyboard().text('✋ Je reprends la main', `takeover:${idx}`),
  confirm: () => new InlineKeyboard().text('✅ Envoyer', 'send').text('❌ Annuler', 'cancel'),
};
