// ══════════════════════════════════════════════════════════════
// controllers/withdrawalController.js — Sanse Capital
// FIXES:
//  1. Usa balanceHelper centralizado
//  2. getPaymentMethods, createPaymentMethod, deletePaymentMethod
//     alineados con el esquema REAL de la tabla payment_methods:
//     (user_id, type, label, phone, account_number, account_type,
//      holder_name, holder_document, is_default, is_active)
//  3. requestWithdrawal + alias createWithdrawalRequest
// ══════════════════════════════════════════════════════════════
const { pool }   = require('../config/database');
const { notify } = require('../utils/telegram');
const { recalculateAndSaveBalance } = require('../utils/balanceHelper');

// ══════════════════════════════════════════════════════════════
// MÉTODOS DE PAGO — Esquema real de la tabla payment_methods
// ══════════════════════════════════════════════════════════════

// GET /api/withdrawals/payment-methods
exports.getPaymentMethods = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, type, label, phone, account_number, account_type, holder_name, holder_document, is_default, created_at
             FROM payment_methods WHERE user_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at DESC`,
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
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
        const { type, label, phone, accountNumber, accountType, holderName, holderDocument, isDefault,
                // Aliases del frontend corregido que mapea a bankName/accountHolder
                bankName, accountHolder } = req.body;

        // Resolver campos: aceptar tanto el esquema nativo como los aliases
        const finalType  = type || (bankName === 'Nequi' ? 'nequi' : bankName === 'Daviplata' ? 'daviplata' : bankName === 'Bancolombia' ? 'bancolombia' : 'otro');
        const finalLabel = label || bankName || '';
        const finalPhone = phone || (finalType === 'nequi' || finalType === 'daviplata' ? accountNumber : null);
        const finalAccountNumber = (finalType === 'bancolombia' || finalType === 'otro') ? (accountNumber || null) : null;
        // FIX: account_type debe ser null para Nequi/Daviplata (no tienen cuenta bancaria)
        // y para Bancolombia debe coincidir con los valores del ENUM de la tabla (ahorros/corriente)
        const finalAccountType   = (finalType === 'nequi' || finalType === 'daviplata')
            ? null
            : (accountType || null);
        const finalHolderName    = holderName || accountHolder || '';
        const finalHolderDoc     = holderDocument || null;

        if (!finalLabel && !finalType) {
            return res.status(400).json({ error: 'Tipo y nombre del método son requeridos' });
        }

        // Si es default, quitar default de los demás
        if (isDefault) {
            await pool.execute(
                `UPDATE payment_methods SET is_default = 0 WHERE user_id = ?`,
                [req.user.id]
            );
        }

        const [result] = await pool.execute(
            `INSERT INTO payment_methods (user_id, type, label, phone, account_number, account_type, holder_name, holder_document, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, finalType, finalLabel, finalPhone, finalAccountNumber, finalAccountType, finalHolderName, finalHolderDoc, isDefault ? 1 : 0]
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
// Acepta AMBOS esquemas:
//   - Directo: { bankName, accountNumber, accountType, accountHolder }
//   - Via paymentMethodId: { paymentMethodId } → busca los datos en la tabla
// ══════════════════════════════════════════════════════════════
exports.requestWithdrawal = async (req, res) => {
    try {
        const userId = req.user.id;
        const amount = parseFloat(req.body.amount);
        let { bankName, accountNumber, accountType, accountHolder, paymentMethodId } = req.body;

        if (!amount || isNaN(amount) || amount < 10000)
            return res.status(400).json({ error: 'Monto mínimo de retiro: $10.000 COP' });

        // Si viene paymentMethodId, buscar los datos de la tabla
        if (paymentMethodId && (!bankName || !accountNumber || !accountHolder)) {
            const [pmRows] = await pool.execute(
                `SELECT type, label, phone, account_number, account_type, holder_name FROM payment_methods WHERE id = ? AND user_id = ? AND is_active = 1`,
                [paymentMethodId, userId]
            );
            if (pmRows.length) {
                const pm = pmRows[0];
                bankName      = bankName || pm.label || pm.type || 'Sin especificar';
                accountNumber = accountNumber || pm.account_number || pm.phone || '';
                accountType   = accountType || pm.account_type || 'savings';
                accountHolder = accountHolder || pm.holder_name || pm.label || '';
            }
        }

        if (!bankName || !accountNumber || !accountHolder)
            return res.status(400).json({ error: 'Datos bancarios incompletos. Selecciona un método de pago o ingresa los datos.' });

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
            [userId, amount, bankName, accountNumber, accountType || null, accountHolder, refId]
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

// Alias para compatibilidad con routes/withdrawals.js
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