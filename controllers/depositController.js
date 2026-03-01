// ══════════════════════════════════════════════════════════════
// DEPOSIT CONTROLLER — Sanse Capital
// ══════════════════════════════════════════════════════════════
const { pool } = require('../config/database');
const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8468569082:AAEpx5VaQOtEQnrz9PHbkyh0O-_LTw0CaLg';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1735923786';

function sendTelegramNotification(message) {
    const data = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' });
    const options = {
        hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    };
    const req = https.request(options);
    req.on('error', (e) => console.error('Telegram error:', e.message));
    req.write(data);
    req.end();
}

// ══════════════════════════════════════════════════════════════
// GET /api/deposits/my — Mis depósitos
// ══════════════════════════════════════════════════════════════
exports.getMyDeposits = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, amount, status, ref_id, note, admin_notes, created_at, processed_at 
             FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC`,
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error getMyDeposits:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// POST /api/deposits/request — Solicitar depósito con comprobante
// ══════════════════════════════════════════════════════════════
exports.requestDeposit = async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount: rawAmount, note, proofImage } = req.body;
        const amount = parseFloat(rawAmount);

        if (!amount || isNaN(amount) || amount < 10000) {
            return res.status(400).json({ error: 'Monto mínimo: $10.000 COP' });
        }
        if (!proofImage || !proofImage.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Debes subir un comprobante de pago (imagen)' });
        }

        // Verificar que no tenga demasiados depósitos pendientes
        const [pending] = await pool.execute(
            `SELECT COUNT(*) as c FROM deposit_requests WHERE user_id = ? AND status = 'pending'`, [userId]
        );
        if (parseInt(pending[0].c) >= 3) {
            return res.status(400).json({ error: 'Ya tienes 3 depósitos pendientes de revisión. Espera a que sean procesados.' });
        }

        const refId = 'DEP-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        await pool.execute(
            `INSERT INTO deposit_requests (user_id, amount, proof_image, note, ref_id) VALUES (?, ?, ?, ?, ?)`,
            [userId, amount, proofImage, note || null, refId]
        );

        // Info del usuario
        const [userRows] = await pool.execute(`SELECT full_name, email, phone FROM users WHERE id = ?`, [userId]);
        const user = userRows[0] || {};

        // Notificar por Telegram
        sendTelegramNotification(
            `📥 *NUEVO DEPÓSITO — Sanse Capital*\n\n` +
            `👤 *${user.full_name || 'Usuario ID:' + userId}*\n` +
            `📧 ${user.email || '—'}\n` +
            `📱 ${user.phone || '—'}\n` +
            `💰 Monto: *$${Math.round(amount).toLocaleString('es-CO')} COP*\n` +
            `🔖 Ref: ${refId}\n` +
            `📝 Nota: ${note || '—'}\n\n` +
            `📷 Comprobante adjunto en el panel admin.\n` +
            `🔗 Revisa en el panel de Depósitos para aprobar.`
        );

        res.status(201).json({
            message: 'Depósito reportado exitosamente. Será verificado pronto.',
            deposit: { refId, amount, status: 'pending' }
        });
    } catch (error) {
        console.error('Error requestDeposit:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: GET /api/admin/deposits — Lista de depósitos
// ══════════════════════════════════════════════════════════════
exports.adminGetDeposits = async (req, res) => {
    try {
        const status = req.query.status || 'all';
        let query = `SELECT dr.*, u.full_name as user_name, u.email as user_email, u.phone as user_phone, u.document_number
                      FROM deposit_requests dr 
                      JOIN users u ON dr.user_id = u.id`;
        const params = [];
        if (status !== 'all') {
            query += ` WHERE dr.status = ?`;
            params.push(status);
        }
        query += ` ORDER BY dr.created_at DESC`;

        const [rows] = await pool.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error adminGetDeposits:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: POST /api/admin/deposits/:id/process — Aprobar/Rechazar depósito
// ══════════════════════════════════════════════════════════════
exports.adminProcessDeposit = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const depositId = req.params.id;
        const { action, notes } = req.body; // action: 'approve' | 'reject'
        const adminId = req.user.id;

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'Acción inválida. Usa: approve o reject' });
        }

        const [depositRows] = await connection.execute(
            `SELECT dr.*, u.full_name, u.email, u.phone FROM deposit_requests dr JOIN users u ON dr.user_id = u.id WHERE dr.id = ?`,
            [depositId]
        );
        if (!depositRows.length) return res.status(404).json({ error: 'Depósito no encontrado' });
        const deposit = depositRows[0];

        if (deposit.status !== 'pending') {
            return res.status(400).json({ error: `Este depósito ya fue procesado (${deposit.status})` });
        }

        if (action === 'approve') {
            // 1. Actualizar estado del depósito
            await connection.execute(
                `UPDATE deposit_requests SET status = 'approved', admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || null, adminId, depositId]
            );

            // 2. Crear transacción de depósito
            const txRefId = 'TXDEP-' + deposit.ref_id.replace('DEP-', '');
            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'deposit', ?, ?, ?, NOW())`,
                [deposit.user_id, deposit.amount, `Depósito aprobado — Ref: ${deposit.ref_id}`, txRefId]
            );

            // 3. Recalcular balance
            const [inRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('deposit','payment','interest','profit','investment_return','investment_withdrawal','loan')`,
                [deposit.user_id]
            );
            const [outRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('withdraw')`,
                [deposit.user_id]
            );
            const newBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));
            const today = new Date().toISOString().slice(0, 10);
            const [existing] = await connection.execute(`SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`, [deposit.user_id, today]);
            if (existing.length) {
                await connection.execute(`UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`, [newBalance, deposit.user_id, today]);
            } else {
                await connection.execute(`INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`, [deposit.user_id, newBalance, today]);
            }

            await connection.commit();

            // Telegram
            sendTelegramNotification(
                `✅ *DEPÓSITO APROBADO — Sanse Capital*\n\n` +
                `👤 ${deposit.full_name}\n` +
                `💰 $${Math.round(parseFloat(deposit.amount)).toLocaleString('es-CO')} COP\n` +
                `🔖 Ref: ${deposit.ref_id}\n` +
                `💼 Nuevo balance: $${Math.round(newBalance).toLocaleString('es-CO')} COP`
            );

            res.json({
                message: `Depósito aprobado. $${Math.round(parseFloat(deposit.amount)).toLocaleString('es-CO')} acreditados.`,
                deposit: { id: depositId, status: 'approved', newBalance },
                // Datos para enviar WhatsApp desde frontend
                whatsapp: {
                    phone: deposit.phone,
                    userName: deposit.full_name,
                    amount: deposit.amount,
                    refId: deposit.ref_id
                }
            });

        } else if (action === 'reject') {
            await connection.execute(
                `UPDATE deposit_requests SET status = 'rejected', admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || 'Depósito rechazado', adminId, depositId]
            );
            await connection.commit();

            sendTelegramNotification(
                `❌ *DEPÓSITO RECHAZADO — Sanse Capital*\n\n` +
                `👤 ${deposit.full_name}\n` +
                `💰 $${Math.round(parseFloat(deposit.amount)).toLocaleString('es-CO')} COP\n` +
                `📝 Motivo: ${notes || '—'}`
            );

            res.json({ message: 'Depósito rechazado.', deposit: { id: depositId, status: 'rejected' } });
        }

    } catch (error) {
        await connection.rollback();
        console.error('Error adminProcessDeposit:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};
