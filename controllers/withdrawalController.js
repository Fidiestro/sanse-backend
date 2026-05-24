// ══════════════════════════════════════════════════════════════
// controllers/withdrawalController.js — Sanse Capital
// v5 — FIX BUG #3: re-validar balance al COMPLETAR retiro.
// Antes solo se validaba al solicitar, pero entre la solicitud y la
// finalización el cliente podía haber perdido balance (invertir,
// otro retiro completado, etc.). Ahora se valida en el momento exacto
// de crear la transacción de salida.
//
// Esquema:
// withdrawal_requests: id, user_id, payment_method_id, amount, status,
//   estimated_completion, admin_notes, ref_id, created_at, updated_at,
//   processed_at, processed_by
//
// payment_methods: id, user_id, type, label, phone, account_number,
//   account_type, holder_name, holder_document, is_default, is_active,
//   updated_at
// ══════════════════════════════════════════════════════════════
const { pool }   = require('../config/database');
const { sendTelegram } = require('../utils/telegram');
const { recalculateAndSaveBalance, INFLOW_TYPES, OUTFLOW_TYPES } = require('../utils/balanceHelper');

// ──────────────────────────────────────────────────────────────
// Helper compartido: calcula balance disponible al momento exacto.
// Usado tanto en requestWithdrawal como en adminProcessWithdrawal
// para evitar approve/complete con saldo insuficiente.
// ──────────────────────────────────────────────────────────────
async function calculateAvailableBalance(connOrPool, userId) {
    const inflowPH  = INFLOW_TYPES.map(() => '?').join(',');
    const outflowPH = OUTFLOW_TYPES.map(() => '?').join(',');

    const [inRows] = await connOrPool.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE user_id = ? AND type IN (${inflowPH})`,
        [userId, ...INFLOW_TYPES]
    );
    const [outRows] = await connOrPool.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE user_id = ? AND type IN (${outflowPH})`,
        [userId, ...OUTFLOW_TYPES]
    );
    const totalBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));

    const [investedRows] = await connOrPool.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM investments
         WHERE user_id = ? AND status IN ('active', 'pending_deposit')`,
        [userId]
    );
    const [pendingWR] = await connOrPool.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests
         WHERE user_id = ? AND status IN ('pending', 'approved')`,
        [userId]
    );

    return totalBalance - parseFloat(investedRows[0].total) - parseFloat(pendingWR[0].total);
}

// ══════════════════════════════════════════════════════════════
// GET /api/withdrawals/payment-methods
// ══════════════════════════════════════════════════════════════
exports.getPaymentMethods = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, type, label, phone, account_number, account_type,
                    holder_name, holder_document, is_default, created_at
             FROM payment_methods
             WHERE user_id = ? AND is_active = 1
             ORDER BY is_default DESC, created_at DESC`,
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') return res.json([]);
        console.error('Error getPaymentMethods:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// POST /api/withdrawals/payment-methods
// ══════════════════════════════════════════════════════════════
exports.createPaymentMethod = async (req, res) => {
    try {
        const { type, label, phone, accountNumber, accountType,
                holderName, holderDocument, isDefault } = req.body;

        if (!type || !label) {
            return res.status(400).json({ error: 'Tipo y nombre del método son requeridos' });
        }

        const finalPhone         = phone || null;
        const finalAccountNumber = accountNumber || null;
        const finalAccountType   = (type === 'nequi' || type === 'daviplata') ? null : (accountType || null);
        const finalHolderName    = holderName || null;
        const finalHolderDoc     = holderDocument || null;

        if (isDefault) {
            await pool.execute(
                `UPDATE payment_methods SET is_default = 0 WHERE user_id = ?`,
                [req.user.id]
            );
        }

        const [result] = await pool.execute(
            `INSERT INTO payment_methods
             (user_id, type, label, phone, account_number, account_type, holder_name, holder_document, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, type, label, finalPhone, finalAccountNumber,
             finalAccountType, finalHolderName, finalHolderDoc, isDefault ? 1 : 0]
        );

        res.status(201).json({ message: 'Método de pago creado', id: result.insertId });
    } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Tabla payment_methods no configurada.' });
        }
        console.error('Error createPaymentMethod:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// DELETE /api/withdrawals/payment-methods/:id
// ══════════════════════════════════════════════════════════════
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
// ══════════════════════════════════════════════════════════════
exports.requestWithdrawal = async (req, res) => {
    try {
        const userId = req.user.id;
        const amount = parseFloat(req.body.amount);
        const { paymentMethodId } = req.body;

        if (!amount || isNaN(amount) || amount < 10000)
            return res.status(400).json({ error: 'Monto mínimo de retiro: $10.000 COP' });

        if (!paymentMethodId)
            return res.status(400).json({ error: 'Selecciona un método de pago' });

        const [pmRows] = await pool.execute(
            `SELECT id, type, label, phone, account_number, holder_name
             FROM payment_methods WHERE id = ? AND user_id = ? AND is_active = 1`,
            [paymentMethodId, userId]
        );
        if (!pmRows.length)
            return res.status(400).json({ error: 'Método de pago no encontrado o inactivo' });

        const pm = pmRows[0];

        // FIX: usar el mismo helper que adminProcessWithdrawal para consistencia
        const availableBalance = await calculateAvailableBalance(pool, userId);

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Saldo disponible insuficiente. Disponible: $${Math.round(Math.max(0, availableBalance)).toLocaleString('es-CO')} COP`,
                available: Math.max(0, availableBalance),
            });
        }

        const estimatedCompletion = amount <= 2000000 ? '24 horas o menos' : 'Hasta 30 días hábiles';
        const refId = 'WR-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        const [result] = await pool.execute(
            `INSERT INTO withdrawal_requests
             (user_id, payment_method_id, amount, status, estimated_completion, ref_id)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
            [userId, paymentMethodId, amount, estimatedCompletion, refId]
        );

        const [userRows] = await pool.execute(`SELECT full_name, email FROM users WHERE id = ?`, [userId]);
        const userName = userRows.length ? userRows[0].full_name : 'Usuario';

        const pmTypeName = pm.type === 'nequi' ? 'Nequi' : pm.type === 'daviplata' ? 'Daviplata' : pm.type === 'bancolombia' ? 'Bancolombia' : pm.label;
        const pmDetail   = pm.phone || pm.account_number || '';

        await sendTelegram(
            `💸 *SOLICITUD DE RETIRO — Sanse Capital*\n\n` +
            `👤 *${userName}*\n` +
            `💰 *$${Math.round(amount).toLocaleString('es-CO')} COP*\n` +
            `🏦 ${pmTypeName} — ${pmDetail}\n` +
            `📋 Titular: ${pm.holder_name || pm.label || '—'}\n` +
            `🔖 Ref: ${refId}\n` +
            `⏱️ Est: ${estimatedCompletion}\n\n` +
            `➡️ Revisa en el panel admin para aprobar o rechazar.`
        );

        res.status(201).json({
            message: 'Solicitud de retiro creada. Será procesada en 24-48 horas.',
            withdrawal: { id: result.insertId, refId, amount, estimatedCompletion },
        });
    } catch (error) {
        console.error('Error solicitando retiro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// Alias para compatibilidad con routes/withdrawals.js
exports.createWithdrawalRequest = exports.requestWithdrawal;

// ══════════════════════════════════════════════════════════════
// GET /api/withdrawals/my
// ══════════════════════════════════════════════════════════════
exports.getMyWithdrawals = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT wr.id, wr.amount, wr.status, wr.ref_id, wr.admin_notes,
                    wr.estimated_completion, wr.created_at, wr.processed_at,
                    pm.type as pm_type, pm.label as pm_label, pm.phone as pm_phone,
                    pm.account_number as pm_account, pm.holder_name as pm_holder
             FROM withdrawal_requests wr
             LEFT JOIN payment_methods pm ON wr.payment_method_id = pm.id
             WHERE wr.user_id = ?
             ORDER BY wr.created_at DESC LIMIT 50`,
            [req.user.id]
        );
        res.json(rows.map(w => ({
            id: w.id,
            amount: parseFloat(w.amount),
            status: w.status,
            refId: w.ref_id,
            adminNotes: w.admin_notes,
            estimatedCompletion: w.estimated_completion,
            createdAt: w.created_at,
            processedAt: w.processed_at,
            pmType: w.pm_type,
            pmLabel: w.pm_label,
            pmPhone: w.pm_phone,
            pmAccount: w.pm_account,
            pmHolder: w.pm_holder,
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
        let query = `SELECT wr.*,
                            u.full_name as user_name, u.email as user_email, u.phone as user_phone,
                            pm.type as pm_type, pm.label as pm_label, pm.phone as pm_phone,
                            pm.account_number as pm_account, pm.account_type as pm_account_type,
                            pm.holder_name as pm_holder, pm.holder_document as pm_holder_doc
                     FROM withdrawal_requests wr
                     LEFT JOIN users u ON wr.user_id = u.id
                     LEFT JOIN payment_methods pm ON wr.payment_method_id = pm.id`;
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
// FIX BUG #3 + #4: atomic UPDATE + re-validar balance en complete.
// ══════════════════════════════════════════════════════════════
exports.adminProcessWithdrawal = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const withdrawalId = req.params.id;
        const { action, notes } = req.body;

        if (!['approve', 'reject', 'complete'].includes(action)) {
            await connection.rollback();
            return res.status(400).json({ error: 'Acción inválida. Usar: approve, reject, complete' });
        }

        const [wrRows] = await connection.execute(
            `SELECT wr.*, pm.type as pm_type, pm.label as pm_label,
                    pm.phone as pm_phone, pm.account_number as pm_account,
                    pm.holder_name as pm_holder
             FROM withdrawal_requests wr
             LEFT JOIN payment_methods pm ON wr.payment_method_id = pm.id
             WHERE wr.id = ?`,
            [withdrawalId]
        );
        if (!wrRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Solicitud no encontrada' });
        }
        const wr = wrRows[0];

        const pmDesc = wr.pm_label || wr.pm_type || '—';
        const pmDetail = wr.pm_phone || wr.pm_account || '';

        if (action === 'approve') {
            // FIX BUG #4: atomic UPDATE para prevenir doble-approve race
            const [updRes] = await connection.execute(
                `UPDATE withdrawal_requests
                 SET status = 'approved', admin_notes = ?, processed_at = NOW(), processed_by = ?
                 WHERE id = ? AND status = 'pending'`,
                [notes || null, req.user.id, withdrawalId]
            );
            if (updRes.affectedRows === 0) {
                await connection.rollback();
                return res.status(400).json({ error: 'Solo se pueden aprobar solicitudes pendientes (puede haber sido procesada por otro admin)' });
            }

            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [wr.user_id]);
            await sendTelegram(
                `✅ *RETIRO APROBADO — Sanse Capital*\n\n` +
                `👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                `💰 $${Math.round(wr.amount).toLocaleString('es-CO')} COP\n` +
                `🏦 ${pmDesc} — ${pmDetail}\n` +
                `🔖 ${wr.ref_id}`
            );

        } else if (action === 'complete') {
            // FIX BUG #3: RE-VALIDAR balance disponible AHORA, no al momento de solicitar.
            // Entre solicitud y completar el cliente pudo haber invertido o tenido otros movimientos.
            // Esto previene crear transacciones 'withdraw' que dejarían balance negativo.
            const realAvailable = await calculateAvailableBalance(connection, wr.user_id);
            const wrAmount = parseFloat(wr.amount);

            // Importante: realAvailable YA excluye este retiro (cuenta como pendiente/aprobado),
            // así que para validar, tenemos que sumarlo de vuelta y comparar.
            const balanceMinusOthers = realAvailable + wrAmount;

            if (wrAmount > balanceMinusOthers) {
                await connection.rollback();
                return res.status(400).json({
                    error: `El cliente ya no tiene saldo suficiente. ` +
                           `Solicitado: $${Math.round(wrAmount).toLocaleString('es-CO')} · ` +
                           `Disponible real: $${Math.round(Math.max(0, balanceMinusOthers)).toLocaleString('es-CO')}. ` +
                           `Considera rechazar este retiro.`,
                    requestedAmount: wrAmount,
                    realAvailable: Math.max(0, balanceMinusOthers),
                });
            }

            const [updRes] = await connection.execute(
                `UPDATE withdrawal_requests
                 SET status = 'completed', admin_notes = ?, processed_at = NOW(), processed_by = ?
                 WHERE id = ? AND status = 'approved'`,
                [notes || null, req.user.id, withdrawalId]
            );
            if (updRes.affectedRows === 0) {
                await connection.rollback();
                return res.status(400).json({ error: 'Solo se pueden completar solicitudes aprobadas (estado puede haber cambiado)' });
            }

            const refId = 'WC-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
                 VALUES (?, 'withdraw', ?, ?, ?, NOW())`,
                [wr.user_id, wr.amount, `Retiro completado — ${pmDesc} ${pmDetail} — Ref: ${wr.ref_id}`, refId]
            );

            const newBalance = await recalculateAndSaveBalance(connection, wr.user_id);

            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [wr.user_id]);
            await sendTelegram(
                `✅ *RETIRO COMPLETADO — Sanse Capital*\n\n` +
                `👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                `💰 $${Math.round(wr.amount).toLocaleString('es-CO')} COP\n` +
                `🏦 ${pmDesc} — ${pmDetail}\n` +
                `💳 Titular: ${wr.pm_holder || '—'}\n` +
                `📊 Nuevo balance: $${Math.round(newBalance).toLocaleString('es-CO')}\n` +
                `🔖 ${wr.ref_id}`
            );

        } else if (action === 'reject') {
            const [updRes] = await connection.execute(
                `UPDATE withdrawal_requests
                 SET status = 'rejected', admin_notes = ?, processed_at = NOW(), processed_by = ?
                 WHERE id = ? AND status IN ('pending', 'approved')`,
                [notes || 'Rechazado por el administrador', req.user.id, withdrawalId]
            );
            if (updRes.affectedRows === 0) {
                await connection.rollback();
                return res.status(400).json({ error: 'No se puede rechazar esta solicitud (estado actual no lo permite)' });
            }

            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [wr.user_id]);
            await sendTelegram(
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