// ════════════════════════════════════════════════════════════════════════
// controllers/supportController.js — Sanse Capital
// Sistema de chat de soporte para depósitos / retiros / ayuda general.
//
// Sigue el mismo patrón que depositController.js:
//   - MySQL2 pool directo
//   - Telegram para notificaciones (throttled, sin spam)
//   - Polling REST cada 3s desde el frontend (sin socket.io)
//
// Flujo:
//   1. Usuario abre chat → POST /api/support/chat (crea o reusa el activo)
//   2. Usuario envía mensaje → POST /api/support/chat/message
//        → Notifica Telegram (primer mensaje SIEMPRE, después throttled 60s)
//   3. Frontend hace polling → GET /api/support/chat/messages?since=<lastId>
//   4. Admin responde desde panel → POST /api/admin/support/chats/:id/message
//   5. Usuario ve la respuesta en ≤3s (polling)
// ════════════════════════════════════════════════════════════════════════

const { pool } = require('../config/database');
const { sendTelegram } = require('../utils/telegram');

// Tiempo mínimo entre notificaciones Telegram por chat (anti-spam)
const TELEGRAM_THROTTLE_MS = 60 * 1000; // 60 segundos

// Tamaño máximo de imagen aceptada (5MB en base64 ≈ 7MB string)
const MAX_IMAGE_LEN = 7 * 1024 * 1024;


// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

async function getUserDisplay(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT full_name, email FROM users WHERE id = ?',
            [userId]
        );
        if (rows.length === 0) return `ID ${userId}`;
        return rows[0].full_name || rows[0].email || `ID ${userId}`;
    } catch (_) {
        return `ID ${userId}`;
    }
}

// Trunca texto largo para mostrar en Telegram
function truncate(s, n = 200) {
    if (!s) return '';
    const t = String(s).trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
}


// ════════════════════════════════════════════════════════════════════════
// USER ENDPOINTS
// ════════════════════════════════════════════════════════════════════════

// POST /api/support/chat
// Crea (o devuelve) el chat ABIERTO del usuario. Idempotente.
exports.openChat = async (req, res) => {
    try {
        const userId = req.user.id;
        const { subject } = req.body || {};

        // ¿Ya tiene chat abierto?
        const [existing] = await pool.execute(
            `SELECT id, status, subject, created_at, last_message_at
             FROM support_chats
             WHERE user_id = ? AND status = 'open'
             ORDER BY id DESC LIMIT 1`,
            [userId]
        );

        if (existing.length > 0) {
            return res.json({ chat: existing[0], reused: true });
        }

        const cleanSubject = (subject && String(subject).trim().slice(0, 120)) || 'Ayuda general';

        const [result] = await pool.execute(
            `INSERT INTO support_chats (user_id, status, subject)
             VALUES (?, 'open', ?)`,
            [userId, cleanSubject]
        );

        return res.status(201).json({
            chat: {
                id: result.insertId,
                status: 'open',
                subject: cleanSubject,
                created_at: new Date(),
                last_message_at: null
            },
            reused: false
        });

    } catch (e) {
        console.error('[supportController.openChat]', e);
        return res.status(500).json({ error: 'Error al abrir el chat' });
    }
};


// GET /api/support/chat
// Devuelve el chat activo del usuario (si existe)
exports.getMyChat = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, status, subject, created_at, last_message_at, unread_user
             FROM support_chats
             WHERE user_id = ? AND status = 'open'
             ORDER BY id DESC LIMIT 1`,
            [req.user.id]
        );
        return res.json({ chat: rows[0] || null });
    } catch (e) {
        console.error('[supportController.getMyChat]', e);
        return res.status(500).json({ error: 'Error al obtener el chat' });
    }
};


// POST /api/support/chat/message
// Usuario envía un mensaje (texto y/o imagen)
exports.sendMessageUser = async (req, res) => {
    try {
        const userId = req.user.id;
        const { text, image, subject } = req.body || {};

        const cleanText = text ? String(text).trim().slice(0, 4000) : '';
        const cleanImage = image && String(image).length < MAX_IMAGE_LEN ? image : null;

        if (!cleanText && !cleanImage) {
            return res.status(400).json({ error: 'Mensaje vacío' });
        }

        // Obtener (o crear) chat activo
        let [chatRows] = await pool.execute(
            `SELECT id, last_notify_at FROM support_chats
             WHERE user_id = ? AND status = 'open'
             ORDER BY id DESC LIMIT 1`,
            [userId]
        );

        let chatId;
        let isFirstMessage = false;
        let lastNotifyAt = null;

        if (chatRows.length === 0) {
            const cleanSubject = (subject && String(subject).trim().slice(0, 120)) || 'Ayuda general';
            const [insertChat] = await pool.execute(
                `INSERT INTO support_chats (user_id, status, subject) VALUES (?, 'open', ?)`,
                [userId, cleanSubject]
            );
            chatId = insertChat.insertId;
            isFirstMessage = true;
        } else {
            chatId = chatRows[0].id;
            lastNotifyAt = chatRows[0].last_notify_at;

            // Verificar si es el primer mensaje del chat
            const [countRows] = await pool.execute(
                `SELECT COUNT(*) AS c FROM support_messages WHERE chat_id = ?`,
                [chatId]
            );
            isFirstMessage = countRows[0].c === 0;
        }

        // Insertar mensaje
        await pool.execute(
            `INSERT INTO support_messages (chat_id, sender, sender_id, text, image_data)
             VALUES (?, 'user', ?, ?, ?)`,
            [chatId, userId, cleanText || null, cleanImage]
        );

        // Actualizar chat: last_message_at + incrementar unread_admin
        await pool.execute(
            `UPDATE support_chats
             SET last_message_at = NOW(),
                 unread_admin = unread_admin + 1,
                 unread_user = 0
             WHERE id = ?`,
            [chatId]
        );

        // Decidir si notificar Telegram (throttling)
        const now = Date.now();
        const lastMs = lastNotifyAt ? new Date(lastNotifyAt).getTime() : 0;
        const shouldNotify = isFirstMessage || (now - lastMs) > TELEGRAM_THROTTLE_MS;

        if (shouldNotify) {
            const userName = await getUserDisplay(userId);
            const preview = cleanText
                ? truncate(cleanText, 200)
                : (cleanImage ? '📷 Imagen adjunta' : '(sin texto)');

            const header = isFirstMessage
                ? '🆘 <b>Nuevo Chat de Ayuda</b>'
                : '💬 <b>Nuevo mensaje en chat de ayuda</b>';

            await sendTelegram(
                `${header}\n\n` +
                `👤 <b>Usuario:</b> ${userName}\n` +
                `🆔 <b>Chat:</b> #${chatId}\n` +
                `📝 <b>Mensaje:</b> ${preview}\n` +
                `🕐 <b>Hora:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}\n\n` +
                `➡️ Responde desde el panel admin → pestaña Soporte`
            );

            await pool.execute(
                `UPDATE support_chats SET last_notify_at = NOW() WHERE id = ?`,
                [chatId]
            );
        }

        return res.status(201).json({ success: true, chatId });

    } catch (e) {
        console.error('[supportController.sendMessageUser]', e);
        return res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
};


// GET /api/support/chat/messages?since=<lastId>
// Polling: devuelve mensajes nuevos del chat activo del usuario
exports.getMessagesUser = async (req, res) => {
    try {
        const userId = req.user.id;
        const since = parseInt(req.query.since) || 0;

        // Encontrar el chat activo
        const [chatRows] = await pool.execute(
            `SELECT id FROM support_chats
             WHERE user_id = ? AND status = 'open'
             ORDER BY id DESC LIMIT 1`,
            [userId]
        );

        if (chatRows.length === 0) {
            return res.json({ chatId: null, messages: [] });
        }

        const chatId = chatRows[0].id;

        const [messages] = await pool.execute(
            `SELECT id, sender, text, image_data, created_at
             FROM support_messages
             WHERE chat_id = ? AND id > ?
             ORDER BY id ASC LIMIT 200`,
            [chatId, since]
        );

        // Marcar como leídos (resetear unread_user)
        if (since === 0 || messages.some(m => m.sender === 'admin')) {
            await pool.execute(
                `UPDATE support_chats SET unread_user = 0 WHERE id = ?`,
                [chatId]
            );
        }

        return res.json({ chatId, messages });

    } catch (e) {
        console.error('[supportController.getMessagesUser]', e);
        return res.status(500).json({ error: 'Error al obtener mensajes' });
    }
};


// POST /api/support/chat/close
// Usuario cierra su propio chat
exports.closeChatUser = async (req, res) => {
    try {
        const [result] = await pool.execute(
            `UPDATE support_chats SET status = 'closed' WHERE user_id = ? AND status = 'open'`,
            [req.user.id]
        );
        return res.json({ success: true, closed: result.affectedRows });
    } catch (e) {
        console.error('[supportController.closeChatUser]', e);
        return res.status(500).json({ error: 'Error al cerrar el chat' });
    }
};


// ════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ════════════════════════════════════════════════════════════════════════

// GET /api/admin/support/chats?status=open|closed|all
exports.adminListChats = async (req, res) => {
    try {
        const { status } = req.query;
        let where = '';
        const params = [];
        if (status === 'open' || status === 'closed') {
            where = 'WHERE sc.status = ?';
            params.push(status);
        }

        const [rows] = await pool.execute(
            `SELECT sc.id, sc.user_id, sc.status, sc.subject,
                    sc.last_message_at, sc.unread_admin, sc.created_at,
                    u.full_name, u.email, u.phone,
                    (SELECT text FROM support_messages
                     WHERE chat_id = sc.id ORDER BY id DESC LIMIT 1) AS last_text,
                    (SELECT sender FROM support_messages
                     WHERE chat_id = sc.id ORDER BY id DESC LIMIT 1) AS last_sender
             FROM support_chats sc
             JOIN users u ON sc.user_id = u.id
             ${where}
             ORDER BY
                CASE WHEN sc.status = 'open' THEN 0 ELSE 1 END,
                COALESCE(sc.last_message_at, sc.created_at) DESC
             LIMIT 200`,
            params
        );

        return res.json({ chats: rows });

    } catch (e) {
        console.error('[supportController.adminListChats]', e);
        return res.status(500).json({ error: 'Error al listar chats' });
    }
};


// GET /api/admin/support/chats/:id/messages?since=<lastId>
exports.adminGetMessages = async (req, res) => {
    try {
        const chatId = parseInt(req.params.id);
        const since = parseInt(req.query.since) || 0;

        if (!chatId) return res.status(400).json({ error: 'chat id inválido' });

        const [chatRows] = await pool.execute(
            `SELECT sc.id, sc.user_id, sc.status, sc.subject, sc.created_at,
                    u.full_name, u.email
             FROM support_chats sc
             JOIN users u ON sc.user_id = u.id
             WHERE sc.id = ?`,
            [chatId]
        );
        if (chatRows.length === 0) return res.status(404).json({ error: 'Chat no encontrado' });

        const [messages] = await pool.execute(
            `SELECT id, sender, text, image_data, created_at
             FROM support_messages
             WHERE chat_id = ? AND id > ?
             ORDER BY id ASC LIMIT 200`,
            [chatId, since]
        );

        // Marcar como leídos (resetear unread_admin) cuando admin consulta
        if (since === 0) {
            await pool.execute(
                `UPDATE support_chats SET unread_admin = 0 WHERE id = ?`,
                [chatId]
            );
        }

        return res.json({ chat: chatRows[0], messages });

    } catch (e) {
        console.error('[supportController.adminGetMessages]', e);
        return res.status(500).json({ error: 'Error al obtener mensajes' });
    }
};


// POST /api/admin/support/chats/:id/message
// Admin responde al chat
exports.adminSendMessage = async (req, res) => {
    try {
        const chatId = parseInt(req.params.id);
        const adminId = req.user.id;
        const { text, image } = req.body || {};

        if (!chatId) return res.status(400).json({ error: 'chat id inválido' });

        const cleanText = text ? String(text).trim().slice(0, 4000) : '';
        const cleanImage = image && String(image).length < MAX_IMAGE_LEN ? image : null;

        if (!cleanText && !cleanImage) {
            return res.status(400).json({ error: 'Mensaje vacío' });
        }

        // Verificar que el chat existe
        const [chatRows] = await pool.execute(
            `SELECT id, user_id, status FROM support_chats WHERE id = ?`,
            [chatId]
        );
        if (chatRows.length === 0) return res.status(404).json({ error: 'Chat no encontrado' });

        // Si está cerrado, reabrirlo (el admin puede responder en cualquier momento)
        if (chatRows[0].status === 'closed') {
            await pool.execute(`UPDATE support_chats SET status = 'open' WHERE id = ?`, [chatId]);
        }

        // Insertar mensaje del admin
        await pool.execute(
            `INSERT INTO support_messages (chat_id, sender, sender_id, text, image_data)
             VALUES (?, 'admin', ?, ?, ?)`,
            [chatId, adminId, cleanText || null, cleanImage]
        );

        // Actualizar chat: last_message_at, resetear unread_admin (yo respondí), incrementar unread_user
        await pool.execute(
            `UPDATE support_chats
             SET last_message_at = NOW(),
                 unread_admin = 0,
                 unread_user = unread_user + 1
             WHERE id = ?`,
            [chatId]
        );

        return res.status(201).json({ success: true });

    } catch (e) {
        console.error('[supportController.adminSendMessage]', e);
        return res.status(500).json({ error: 'Error al enviar mensaje' });
    }
};


// POST /api/admin/support/chats/:id/close
exports.adminCloseChat = async (req, res) => {
    try {
        const chatId = parseInt(req.params.id);
        if (!chatId) return res.status(400).json({ error: 'chat id inválido' });

        await pool.execute(`UPDATE support_chats SET status = 'closed' WHERE id = ?`, [chatId]);
        return res.json({ success: true });

    } catch (e) {
        console.error('[supportController.adminCloseChat]', e);
        return res.status(500).json({ error: 'Error al cerrar chat' });
    }
};


// GET /api/admin/support/unread-count
// Para mostrar badge con número de chats con mensajes nuevos
exports.adminUnreadCount = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT
                COUNT(*) AS open_chats,
                COALESCE(SUM(unread_admin), 0) AS unread_messages,
                COUNT(CASE WHEN unread_admin > 0 THEN 1 END) AS chats_with_unread
             FROM support_chats
             WHERE status = 'open'`
        );
        return res.json(rows[0]);
    } catch (e) {
        console.error('[supportController.adminUnreadCount]', e);
        return res.json({ open_chats: 0, unread_messages: 0, chats_with_unread: 0 });
    }
};