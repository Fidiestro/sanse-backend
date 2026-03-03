// ══════════════════════════════════════════════════════════════
// utils/telegram.js — Sanse Capital
// Módulo centralizado para notificaciones Telegram.
// Todos los controllers importan desde aquí — NUNCA hardcodear
// el token directamente en los controllers.
// ══════════════════════════════════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Envía un mensaje de texto a Telegram.
 * No lanza excepciones — los errores se loguean y se ignoran
 * para no interrumpir el flujo principal de la aplicación.
 * @param {string} message — Texto con soporte Markdown
 */
async function notify(message) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.warn('⚠️  Telegram: TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados en .env');
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id:    CHAT_ID,
                text:       message,
                parse_mode: 'Markdown',
            }),
        });
        if (!res.ok) {
            const body = await res.text();
            console.error('Telegram API error:', res.status, body);
        }
    } catch (err) {
        console.error('Error enviando notificación Telegram:', err.message);
    }
}

module.exports = { notify };