const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Envía un mensaje al bot de Telegram configurado.
 * Usa https nativo de Node — sin dependencias externas.
 * @param {string} message - Texto HTML a enviar
 */
function sendTelegram(message) {
  return new Promise((resolve) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.warn('[Telegram] TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados en .env');
      return resolve();
    }

    const body = JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text:       message,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      port:     443,
      path:     `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });

    req.on('error', (e) => {
      console.error('[Telegram] Error enviando mensaje:', e.message);
      resolve(); // no lanzar error — el depósito igual debe guardarse
    });

    req.write(body);
    req.end();
  });
}

module.exports = { sendTelegram };