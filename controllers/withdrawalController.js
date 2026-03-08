// ══════════════════════════════════════════════════════════════
// controllers/withdrawalController.js — Sanse Capital
// FIXES:
//  1. Usa balanceHelper centralizado
//  2. Agrega métodos faltantes: getPaymentMethods, createPaymentMethod,
//     deletePaymentMethod, createWithdrawalRequest (aliases)
// ══════════════════════════════════════════════════════════════
const { pool }   = require('../config/database');
const { notify } = require('../utils/telegram');
const { recalculateAndSaveBalance } = require('../utils/balanceHelper');

// ══════════════════════════════════════════════════════════════
// MÉTODOS DE PAGO — Requeridos por routes/withdrawals.js
// FIX: Estos métodos no existían, causando crash al cargar rutas
// ══════════════════════════════════════════════════════════════

// GET /api/withdrawals/payment-methods
exports.getPaymentMethods = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, bank_name, account_number, account_type, account_holder, is_default, created_at
             FROM payment_methods WHERE user_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at DESC`,
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
        // Si la tabla no existe aún, devolver array vacío
        if (error.code === 'ER_NO_SUCH_TABLE') {
            return res.json([]);
        }
        console.error('Error getPaymentMethods:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/withdrawals/payment-methods
exports.createPaymentMethod = async (req, res) => {
    try {
        const { bankName, accountNumber, accountType, accountHolder, isDefault } = req.body;
        if (!bankName || !accountNumber || !accountHolder) {
            return res.status(400).json({ error: 'Banco, número de cuenta y titular son requeridos' });
        }

        // Si es default, quitar default de los demás
        if (isDefault) {
            await pool.execute(
                `UPDATE payment_methods SET is_default = 0 WHERE user_id = ?`,
                [req.user.id]
            );
        }

        const [result] = await pool.execute(
            `INSERT INTO payment_methods (user_id, bank_name, account_number, account_type, account_holder, is_default)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.id, bankName, accountNumber, accountType || 'savings', accountHolder, isDefault ? 1 : 0]
        );

        res.status(201).json({ message: 'Método de pago creado', id: result.insertId });
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Tabla payment_methods no configurada. Contacta al administrador.' });
        }
        console.error('Error createPaymentMethod:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// DELETE /api/withdrawals/payment-methods/:id
exports.deletePaymentMethod = async (req, res) => {
    try {
        const [result] = await pool.execute(
            `UPDATE payment_methods SET is_active = 0 WHERE id = ? AND user_id = ?`,
            [req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Método de pago no encontrado' });
        }
        res.json({ message: 'Método de pago eliminado' });
    } catch (error) {
        console.error('Error deletePaymentMethod:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// POST /api/withdrawals/request
// FIX: También exportado como createWithdrawalRequest (alias)
//      para que routes/withdrawals.js funcione correctamente
// ══════════════════════════════════════════════════════════════
exports.requestWithdrawal = async (req, res) => {
    try {
        const userId = req.user.id;
        const amount = parseFloat(req.body.amount);
        const { bankName, accountNumber, accountType, accountHolder } = req.body;

        if (!amount || isNaN(amount) || amount < 10000)
            return res.status(400).json({ error: 'Monto mínimo de retiro: $10.000 COP' });
        if (!bankName || !accountNumber || !accountHolder)
            return res.status(400).json({ error: 'Datos bancarios incompletos' });

        // Balance disponible
        const [balRows] = await pool.execute(
            `SELECT amount FROM balance_history WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`,
            [userId]
        );
        const currentBalance = balRows.length ? parseFloat(balRows[0].amount) : 0;

        const [investedRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments
             WHERE user_id = ? AND status IN ('active', 'pending_deposit')`,
            [userId]
        );
        const [pendingWR] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests
             WHERE user_id = ? AND status IN ('pending', 'approved')`,
            [userId]
        );

        const investedAmount = parseFloat(investedRows[0].total);
        const pendingWithdrawals = parseFloat(pendingWR[0].total);
        const availableBalance = currentBalance - investedAmount - pendingWithdrawals;

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Saldo disponible insuficiente. Disponible: $${Math.round(Math.max(0, availableBalance)).toLocaleString('es-CO')} COP`,
                available: Math.max(0, availableBalance),
            });
        }

        const refId = 'WR-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        const [result] = await pool.execute(
            `INSERT INTO withdrawal_requests
             (user_id, amount, bank_name, account_number, account_type, account_holder, status, ref_id)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [userId, amount, bankName, accountNumber, accountType || 'savings', accountHolder, refId]
        );

        const [userRows] = await pool.execute(`SELECT full_name, email FROM users WHERE id = ?`, [userId]);
        const userName = userRows.length ? userRows[0].full_name : 'Usuario';

        await notify(
            `💸 *SOLICITUD DE RETIRO — Sanse Capital*\n\n` +
            `👤 *${userName}*\n` +
            `💰 *$${Math.round(amount).toLocaleString('es-CO')} COP*\n` +
            `🏦 ${bankName} — ${accountType || 'Ahorros'}\n` +
            `📋 Titular: ${accountHolder}\n` +
            `🔢 Cuenta: ${accountNumber}\n` +
            `🔖 Ref: ${refId}\n\n` +
            `➡️ Revisa en el panel admin para aprobar o rechazar.`
        );

        res.status(201).json({
            message: 'Solicitud de retiro creada. Será procesada en 24-48 horas.',
            withdrawal: { id: result.insertId, refId, amount },
        });
    } catch (error) {
        console.error('Error solicitando retiro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// FIX: Alias para compatibilidad con routes/withdrawals.js
exports.createWithdrawalRequest = exports.requestWithdrawal;

// ══════════════════════════════════════════════════════════════
// GET /api/withdrawals/my
// ══════════════════════════════════════════════════════════════
exports.getMyWithdrawals = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT * FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [req.user.id]
        );
        res.json(rows.map(w => ({
            id: w.id,
            amount: parseFloat(w.amount),
            bankName: w.bank_name,
            accountNumber: w.account_number,
            accountType: w.account_type,
            accountHolder: w.account_holder,
            status: w.status,
            refId: w.ref_id,
            adminNotes: w.admin_notes,
            createdAt: w.created_at,
            processedAt: w.processed_at,
        })));
    } catch (error) {
        console.error('Error obteniendo retiros:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: GET /api/admin/withdrawals
// ══════════════════════════════════════════════════════════════
exports.adminGetWithdrawals = async (req, res) => {
    try {
        const status = req.query.status || 'all';
        let query = `SELECT wr.*, u.full_name as user_name, u.email as user_email, u.phone as user_phone
                     FROM withdrawal_requests wr LEFT JOIN users u ON wr.user_id = u.id`;
        const params = [];
        if (status !== 'all') { query += ` WHERE wr.status = ?`; params.push(status); }
        query += ` ORDER BY wr.created_at DESC LIMIT 50`;

        const [rows] = await pool.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error obteniendo retiros admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: POST /api/admin/withdrawals/:id/process
// FIX: Usa balanceHelper centralizado
// ══════════════════════════════════════════════════════════════
exports.adminProcessWithdrawal = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const withdrawalId = req.params.id;
        const { action, notes } = req.body;

        if (!['approve', 'reject', 'complete'].includes(action)) {
            return res.status(400).json({ error: 'Acción inválida. Usar: approve, reject, complete' });
        }

        const [wrRows] = await connection.execute(
            `SELECT * FROM withdrawal_requests WHERE id = ?`, [withdrawalId]
        );
        if (!wrRows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
        const wr = wrRows[0];

        if (action === 'approve') {
            if (wr.status !== 'pending')
                return res.status(400).json({ error: 'Solo se pueden aprobar solicitudes pendientes' });

            await connection.execute(
                `UPDATE withdrawal_requests SET status = 'approved', admin_notes = ?,
                 processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || null, req.user.id, withdrawalId]
            );

            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [wr.user_id]);
            await notify(
                `✅ *RETIRO APROBADO — Sanse Capital*\n\n` +
                `👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                `💰 $${Math.round(wr.amount).toLocaleString('es-CO')} COP\n` +
                `🏦 ${wr.bank_name} — ${wr.account_number}\n` +
                `🔖 ${wr.ref_id}`
            );

        } else if (action === 'complete') {
            if (wr.status !== 'approved')
                return res.status(400).json({ error: 'Solo se pueden completar solicitudes aprobadas' });

            const refId = 'WC-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
                 VALUES (?, 'withdraw', ?, ?, ?, NOW())`,
                [wr.user_id, wr.amount, `Retiro completado — Ref: ${wr.ref_id}`, refId]
            );

            await connection.execute(
                `UPDATE withdrawal_requests SET status = 'completed', admin_notes = ?,
                 processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || null, req.user.id, withdrawalId]
            );

            // FIX: Usa balanceHelper centralizado
            const newBalance = await recalculateAndSaveBalance(connection, wr.user_id);

            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [wr.user_id]);
            await notify(
                `✅ *RETIRO COMPLETADO — Sanse Capital*\n\n` +
                `👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                `💰 $${Math.round(wr.amount).toLocaleString('es-CO')} COP\n` +
                `🏦 ${wr.bank_name} — ${wr.account_number}\n` +
                `💳 Titular: ${wr.account_holder}\n` +
                `📊 Nuevo balance: $${Math.round(newBalance).toLocaleString('es-CO')}\n` +
                `🔖 ${wr.ref_id}`
            );

        } else if (action === 'reject') {
            if (wr.status !== 'pending' && wr.status !== 'approved')
                return res.status(400).json({ error: 'No se puede rechazar esta solicitud' });

            await connection.execute(
                `UPDATE withdrawal_requests SET status = 'rejected', admin_notes = ?,
                 processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || 'Rechazado por el administrador', req.user.id, withdrawalId]
            );

            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [wr.user_id]);
            await notify(
                `❌ *RETIRO RECHAZADO — Sanse Capital*\n\n` +
                `👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                `💰 $${Math.round(wr.amount).toLocaleString('es-CO')} COP\n` +
                `📝 Motivo: ${notes || 'Sin especificar'}\n` +
                `🔖 ${wr.ref_id}`
            );
        }

        await connection.commit();
        const statusLabels = { approve: 'aprobada', reject: 'rechazada', complete: 'completada' };
        res.json({ message: `Solicitud ${statusLabels[action]}` });

    } catch (error) {
        await connection.rollback();
        console.error('Error procesando retiro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};
