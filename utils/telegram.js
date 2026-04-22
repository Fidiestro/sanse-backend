const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Envía un mensaje al bot de Telegram configurado.
 * @param {string} message - Texto HTML a enviar
 */
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados en .env');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      }
    );
  } catch (e) {
    console.error('[Telegram] Error enviando mensaje:', e.message);
  }
}

module.exports = { sendTelegram };