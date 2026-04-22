// ══════════════════════════════════════════════════════════════
// controllers/depositController.js — Sanse Capital
// Tabla real: deposit_requests (MySQL2 pool directo)
// ══════════════════════════════════════════════════════════════
const { pool } = require('../config/database');
const { sendTelegram } = require('../utils/telegram');

// ══════════════════════════════════════════════
// RUTAS DE USUARIO
// ══════════════════════════════════════════════

/**
 * POST /api/deposits/create
 * Usuario envía comprobante → queda pendiente + alerta Telegram al admin
 */
exports.create = async (req, res) => {
    try {
        const { amount, note, proofImage, fileName } = req.body;
        const userId = req.user.id;

        if (!amount || isNaN(Number(amount)) || Number(amount) < 10000) {
            return res.status(400).json({ error: 'El monto mínimo es $10,000 COP' });
        }
        if (!proofImage) {
            return res.status(400).json({ error: 'El comprobante es requerido' });
        }

        // Insertar en deposit_requests (tabla real del sistema)
        const [result] = await pool.execute(
            `INSERT INTO deposit_requests (user_id, amount, note, proof_image, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', NOW(), NOW())`,
            [userId, Number(amount), note || '', proofImage]
        );

        const depositId = result.insertId;

        // Obtener nombre del usuario para Telegram
        let userName = `ID ${userId}`;
        try {
            const [userRows] = await pool.execute(
                'SELECT full_name, email FROM users WHERE id = ?',
                [userId]
            );
            if (userRows.length > 0) {
                userName = userRows[0].full_name || userRows[0].email || userName;
            }
        } catch (_) {}

        // Notificación Telegram al admin
        await sendTelegram(
            `💰 <b>Nuevo Depósito Pendiente</b>\n\n` +
            `👤 <b>Usuario:</b> ${userName}\n` +
            `💵 <b>Monto:</b> $${Number(amount).toLocaleString('es-CO')} COP\n` +
            `📝 <b>Nota:</b> ${note || 'Sin nota'}\n` +
            `🕐 <b>Fecha:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}\n` +
            `🔎 <b>Estado:</b> Pendiente de revisión\n` +
            `🆔 <b>Depósito ID:</b> ${depositId}`
        );

        return res.status(201).json({
            success: true,
            deposit: { id: depositId, amount: Number(amount), status: 'pending' }
        });

    } catch (e) {
        console.error('[depositController.create]', e);
        return res.status(500).json({ error: 'Error interno al registrar el depósito' });
    }
};

/**
 * GET /api/deposits/my
 * Lista los depósitos del usuario autenticado (sin el base64 pesado)
 */
exports.myDeposits = async (req, res) => {
    try {
        const [deposits] = await pool.execute(
            `SELECT id, user_id, amount, note, status, admin_notes, processed_at, created_at, updated_at
             FROM deposit_requests
             WHERE user_id = ?
             ORDER BY created_at DESC`,
            [req.user.id]
        );
        return res.json(deposits);
    } catch (e) {
        console.error('[depositController.myDeposits]', e);
        return res.status(500).json({ error: 'Error al obtener depósitos' });
    }
};

// ══════════════════════════════════════════════
// RUTAS DE ADMIN
// (usadas por routes/admin.js)
// ══════════════════════════════════════════════

/**
 * GET /api/admin/deposits
 * Lista todos los depósitos para el panel admin, con datos del usuario
 */
exports.adminGetDeposits = async (req, res) => {
    try {
        const { status } = req.query; // ?status=pending (opcional)

        let query = `
            SELECT
                dr.id, dr.user_id, dr.amount, dr.note, dr.status,
                dr.admin_notes, dr.processed_at, dr.processed_by,
                dr.created_at, dr.updated_at,
                u.full_name AS user_name,
                u.email     AS user_email
            FROM deposit_requests dr
            LEFT JOIN users u ON dr.user_id = u.id
        `;
        const params = [];

        if (status) {
            query += ' WHERE dr.status = ?';
            params.push(status);
        }

        query += ' ORDER BY dr.created_at DESC';

        const [deposits] = await pool.execute(query, params);
        return res.json(deposits);

    } catch (e) {
        console.error('[depositController.adminGetDeposits]', e);
        return res.status(500).json({ error: 'Error al obtener depósitos' });
    }
};

/**
 * POST /api/admin/deposits/:id/process
 * Admin aprueba o rechaza un depósito
 * Body: { action: 'approve' | 'reject', adminNote: '' }
 */
exports.adminProcessDeposit = async (req, res) => {
    try {
        const { id }                  = req.params;
        const { action, adminNote }   = req.body;
        const adminId                 = req.user.id;

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ error: 'Acción inválida. Usa: approve | reject' });
        }

        // Verificar que existe y está pendiente
        const [rows] = await pool.execute(
            `SELECT dr.*, u.full_name, u.email
             FROM deposit_requests dr
             LEFT JOIN users u ON dr.user_id = u.id
             WHERE dr.id = ?`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Depósito no encontrado' });
        }

        const deposit = rows[0];

        if (deposit.status !== 'pending') {
            return res.status(400).json({ error: `El depósito ya fue procesado (${deposit.status})` });
        }

        const newStatus = action === 'approve' ? 'approved' : 'rejected';

        // Actualizar estado
        await pool.execute(
            `UPDATE deposit_requests
             SET status = ?, admin_notes = ?, processed_at = NOW(), processed_by = ?, updated_at = NOW()
             WHERE id = ?`,
            [newStatus, adminNote || '', adminId, id]
        );

        // Si se aprueba → registrar transacción de depósito y recalcular balance
        if (action === 'approve') {
            await pool.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
                 VALUES (?, 'deposit', ?, ?, ?, NOW())`,
                [
                    deposit.user_id,
                    deposit.amount,
                    `Depósito aprobado #${id}${deposit.note ? ' — ' + deposit.note : ''}`,
                    id
                ]
            );

            // Recalcular balance (mismo patrón que balanceHelper)
            const { recalculateAndSaveBalance } = require('../utils/balanceHelper');
            await recalculateAndSaveBalance(pool, deposit.user_id);
        }

        // Notificación Telegram
        const emoji    = action === 'approve' ? '✅' : '❌';
        const label    = action === 'approve' ? 'Aprobado' : 'Rechazado';
        const userName = deposit.full_name || deposit.email || `ID ${deposit.user_id}`;

        await sendTelegram(
            `${emoji} <b>Depósito ${label}</b>\n\n` +
            `🆔 <b>ID:</b> ${id}\n` +
            `👤 <b>Usuario:</b> ${userName}\n` +
            `💵 <b>Monto:</b> $${Number(deposit.amount).toLocaleString('es-CO')} COP\n` +
            `📝 <b>Nota admin:</b> ${adminNote || 'Sin nota'}\n` +
            `🕐 <b>Procesado:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
        );

        return res.json({ success: true, status: newStatus });

    } catch (e) {
        console.error('[depositController.adminProcessDeposit]', e);
        return res.status(500).json({ error: 'Error al procesar el depósito' });
    }
};
