/* ============================================================
   POST /api/lead-photo  →  заявка + фото уходят в Telegram-бота
   Вставь этот блок в свой server.js (Express, порт 5000).

   .env:
     TELEGRAM_BOT_TOKEN=123456:AA...      // токен от @BotFather
     TELEGRAM_CHAT_ID=123456789           // твой chat_id (узнать: @userinfobot)

   Заявка дублируется в Firestore-коллекцию `leads_portfolio`
   (если подключён firebase-admin) — блок можно убрать.
   ============================================================ */

const express = require('express');
const router = express.Router();

// лимит на JSON: фото приходят как dataURL (base64), 6 шт × ~4 МБ
// в server.js: app.use(express.json({ limit: '40mb' }));

const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const esc = (s = '') => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function tgSendMessage(text) {
  const r = await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`sendMessage ${r.status}: ${await r.text()}`);
  return r.json();
}

async function tgSendPhoto(dataUrl, filename, caption) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');

  const form = new FormData();
  form.append('chat_id', CHAT);
  if (caption) form.append('caption', caption);
  // sendDocument — без сжатия, ретушёру важны пиксели
  form.append('document', new Blob([buf], { type: m[1] }), filename || 'photo.jpg');

  const r = await fetch(`${TG}/sendDocument`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`sendDocument ${r.status}: ${await r.text()}`);
  return r.json();
}

router.post('/api/lead-photo', async (req, res) => {
  try {
    const { name = '', contact = '', task = '', message = '', photos = [], source = 'portfolio' } = req.body || {};

    if (!name.trim() || !contact.trim()) {
      return res.status(400).json({ ok: false, error: 'name и contact обязательны' });
    }
    if (!process.env.TELEGRAM_BOT_TOKEN || !CHAT) {
      return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы' });
    }

    const list = Array.isArray(photos) ? photos.slice(0, 6) : [];

    const text =
      `<b>Новая заявка с портфолио</b>\n\n` +
      `<b>Имя:</b> ${esc(name)}\n` +
      `<b>Связь:</b> ${esc(contact)}\n` +
      `<b>Задача:</b> ${esc(task) || '—'}\n` +
      `<b>Фото:</b> ${list.length}\n\n` +
      `${esc(message) || '<i>без сообщения</i>'}\n\n` +
      `<i>${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Warsaw' })} · ${esc(source)}</i>`;

    await tgSendMessage(text);

    for (let i = 0; i < list.length; i++) {
      try {
        await tgSendPhoto(list[i].dataUrl, list[i].name || `photo-${i + 1}.jpg`, `${name} — ${i + 1}/${list.length}`);
      } catch (e) {
        console.error('photo send failed', i, e.message);
        await tgSendMessage(`⚠️ Фото ${i + 1} не ушло: ${esc(e.message)}`);
      }
    }

    // (опционально) дубль заявки в Firestore
    try {
      if (global.adminDb) {
        await global.adminDb.collection('leads_portfolio').add({
          name, contact, task, message,
          photosCount: list.length,
          source,
          createdAt: new Date().toISOString(),
          status: 'new',
        });
      }
    } catch (e) {
      console.error('firestore log failed', e.message);
    }

    res.json({ ok: true, photos: list.length });
  } catch (e) {
    console.error('lead-photo error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

/* в server.js:
     const leadRouter = require('./telegram-lead-endpoint');
     app.use(express.json({ limit: '40mb' }));
     app.use(cors());            // чтобы сайт с другого домена мог постить
     app.use(leadRouter);
*/
