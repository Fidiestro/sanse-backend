const { pool } = require('../config/database');

// ══════════════════════════════════════════════════════
// MÉTODOS DE PAGO
// ══════════════════════════════════════════════════════

// GET /api/withdrawals/payment-methods — Listar métodos de pago del usuario
exports.getPaymentMethods = async (req, res) => {
    try {
        const userId = req.user.id;
        const [rows] = await pool.execute(
            `SELECT id, type, label, phone, account_number, account_type, holder_name, holder_document, is_default, created_at
             FROM payment_methods WHERE user_id = ? AND is_active = 1 ORDER BY is_default DESC, created_at DESC`,
            [userId]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error obteniendo métodos de pago:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/withdrawals/payment-methods — Crear método de pago
exports.createPaymentMethod = async (req, res) => {
    try {
        const userId = req.user.id;
        const { type, label, phone, accountNumber, accountType, holderName, holderDocument } = req.body;

        if (!type || !label) {
            return res.status(400).json({ error: 'Tipo y nombre del método son requeridos' });
        }

        // Validar según tipo
        if (type === 'nequi' || type === 'daviplata') {
            if (!phone) return res.status(400).json({ error: 'Número de teléfono es requerido para ' + type });
            if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'El teléfono debe tener 10 dígitos' });
        }
        if (type === 'bancolombia') {
            if (!accountNumber) return res.status(400).json({ error: 'Número de cuenta es requerido' });
            if (!accountType) return res.status(400).json({ error: 'Tipo de cuenta es requerido (ahorros/corriente)' });
            if (!holderName) return res.status(400).json({ error: 'Nombre del titular es requerido' });
        }

        // Verificar máximo 3 métodos activos
        const [countRows] = await pool.execute(
            `SELECT COUNT(*) as c FROM payment_methods WHERE user_id = ? AND is_active = 1`,
            [userId]
        );
        if (countRows[0].c >= 3) {
            return res.status(400).json({ error: 'Máximo 3 métodos de pago permitidos. Elimina uno antes de agregar otro.' });
        }

        // Si es el primero, hacerlo default
        const isDefault = countRows[0].c === 0 ? 1 : 0;

        const [result] = await pool.execute(
            `INSERT INTO payment_methods (user_id, type, label, phone, account_number, account_type, holder_name, holder_document, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, type, label, phone || null, accountNumber || null, accountType || null, holderName || null, holderDocument || null, isDefault]
        );

        res.status(201).json({
            message: 'Método de pago registrado',
            id: result.insertId,
            type, label, isDefault,
        });
    } catch (error) {
        console.error('Error creando método de pago:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// DELETE /api/withdrawals/payment-methods/:id — Eliminar método de pago
exports.deletePaymentMethod = async (req, res) => {
    try {
        const userId = req.user.id;
        const pmId = req.params.id;

        // Verificar que no tenga retiros pendientes con este método
        const [pending] = await pool.execute(
            `SELECT COUNT(*) as c FROM withdrawal_requests WHERE payment_method_id = ? AND status IN ('pending', 'approved')`,
            [pmId]
        );
        if (pending[0].c > 0) {
            return res.status(400).json({ error: 'No puedes eliminar un método con retiros pendientes' });
        }

        await pool.execute(
            `UPDATE payment_methods SET is_active = 0 WHERE id = ? AND user_id = ?`,
            [pmId, userId]
        );
        res.json({ message: 'Método de pago eliminado' });
    } catch (error) {
        console.error('Error eliminando método de pago:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════
// SOLICITUDES DE RETIRO
// ══════════════════════════════════════════════════════

// GET /api/withdrawals/my — Historial de solicitudes del usuario
exports.getMyWithdrawals = async (req, res) => {
    try {
        const userId = req.user.id;
        const [rows] = await pool.execute(
            `SELECT wr.*, pm.type as pm_type, pm.label as pm_label, pm.phone as pm_phone, pm.account_number as pm_account
             FROM withdrawal_requests wr
             LEFT JOIN payment_methods pm ON wr.payment_method_id = pm.id
             WHERE wr.user_id = ?
             ORDER BY wr.created_at DESC LIMIT 20`,
            [userId]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error obteniendo retiros:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/withdrawals/request — Crear solicitud de retiro
exports.createWithdrawalRequest = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const { amount, paymentMethodId } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Monto inválido' });
        }
        if (!paymentMethodId) {
            return res.status(400).json({ error: 'Selecciona un método de pago' });
        }

        // 1. Verificar método de pago pertenece al usuario
        const [pmRows] = await connection.execute(
            `SELECT * FROM payment_methods WHERE id = ? AND user_id = ? AND is_active = 1`,
            [paymentMethodId, userId]
        );
        if (!pmRows.length) {
            return res.status(404).json({ error: 'Método de pago no encontrado' });
        }

        // 2. Verificar balance disponible
        const [balanceRows] = await connection.execute(
            `SELECT amount FROM balance_history WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`,
            [userId]
        );
        const currentBalance = balanceRows.length > 0 ? parseFloat(balanceRows[0].amount) : 0;

        const [investedRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status = 'active'`,
            [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);
        const availableBalance = currentBalance - totalInvested;

        // También restar retiros pendientes
        const [pendingRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`,
            [userId]
        );
        const pendingAmount = parseFloat(pendingRows[0].total);
        const realAvailable = availableBalance - pendingAmount;

        if (amount > realAvailable) {
            return res.status(400).json({
                error: `Saldo disponible insuficiente. Disponible: $${Math.round(realAvailable).toLocaleString('es-CO')} COP`,
                available: realAvailable,
            });
        }

        // 3. Verificar límite mensual de $2.000.000
        const [monthlyRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests 
             WHERE user_id = ? AND status IN ('pending', 'approved', 'completed')
             AND YEAR(created_at) = YEAR(NOW()) AND MONTH(created_at) = MONTH(NOW())`,
            [userId]
        );
        const monthlyTotal = parseFloat(monthlyRows[0].total);
        const monthlyRemaining = 2000000 - monthlyTotal;

        if (amount > monthlyRemaining) {
            return res.status(400).json({
                error: `Límite mensual de retiro: $2.000.000 COP. Ya has solicitado $${Math.round(monthlyTotal).toLocaleString('es-CO')} este mes. Disponible: $${Math.round(Math.max(0, monthlyRemaining)).toLocaleString('es-CO')}`,
                monthlyUsed: monthlyTotal,
                monthlyRemaining: Math.max(0, monthlyRemaining),
            });
        }

        // 4. Determinar tiempo estimado
        let estimatedCompletion = '48 horas';
        if (amount > 2000000) {
            estimatedCompletion = '30 días';
        }

        // 5. Crear solicitud
        const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM withdrawal_requests');
        const refId = 'RET-' + String(countRows[0].c + 1).padStart(5, '0');

        const [result] = await connection.execute(
            `INSERT INTO withdrawal_requests (user_id, payment_method_id, amount, status, estimated_completion, ref_id)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
            [userId, paymentMethodId, amount, estimatedCompletion, refId]
        );

        await connection.commit();

        res.status(201).json({
            message: 'Solicitud de retiro creada exitosamente',
            withdrawal: {
                id: result.insertId,
                amount,
                refId,
                status: 'pending',
                estimatedCompletion,
                paymentMethod: pmRows[0].label,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error creando solicitud de retiro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ══════════════════════════════════════════════════════
// ADMIN: Gestión de retiros
// ══════════════════════════════════════════════════════

// GET /api/admin/withdrawals — Listar todas las solicitudes
exports.adminGetWithdrawals = async (req, res) => {
    try {
        const status = req.query.status || 'all';
        let query = `SELECT wr.*, u.full_name as user_name, u.email as user_email, u.document_number,
                     pm.type as pm_type, pm.label as pm_label, pm.phone as pm_phone, 
                     pm.account_number as pm_account, pm.account_type as pm_account_type,
                     pm.holder_name as pm_holder, pm.holder_document as pm_holder_doc
                     FROM withdrawal_requests wr
                     LEFT JOIN users u ON wr.user_id = u.id
                     LEFT JOIN payment_methods pm ON wr.payment_method_id = pm.id`;
        
        const params = [];
        if (status !== 'all') {
            query += ` WHERE wr.status = ?`;
            params.push(status);
        }
        query += ` ORDER BY wr.created_at DESC LIMIT 50`;

        const [rows] = await pool.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error obteniendo retiros admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/withdrawals/:id/process — Aprobar o rechazar retiro
exports.adminProcessWithdrawal = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const wrId = req.params.id;
        const adminId = req.user.id;
        const { action, notes } = req.body; // action: 'approve', 'reject', 'complete'

        if (!['approve', 'reject', 'complete'].includes(action)) {
            return res.status(400).json({ error: 'Acción inválida. Usar: approve, reject, complete' });
        }

        const [wrRows] = await connection.execute(
            `SELECT * FROM withdrawal_requests WHERE id = ?`, [wrId]
        );
        if (!wrRows.length) {
            return res.status(404).json({ error: 'Solicitud no encontrada' });
        }
        const wr = wrRows[0];

        if (action === 'approve' && wr.status !== 'pending') {
            return res.status(400).json({ error: 'Solo se pueden aprobar solicitudes pendientes' });
        }
        if (action === 'complete' && wr.status !== 'approved') {
            return res.status(400).json({ error: 'Solo se pueden completar solicitudes aprobadas' });
        }
        if (action === 'reject' && !['pending', 'approved'].includes(wr.status)) {
            return res.status(400).json({ error: 'No se puede rechazar esta solicitud' });
        }

        let newStatus;
        if (action === 'approve') newStatus = 'approved';
        else if (action === 'reject') newStatus = 'rejected';
        else newStatus = 'completed';

        await connection.execute(
            `UPDATE withdrawal_requests SET status = ?, admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
            [newStatus, notes || null, adminId, wrId]
        );

        // Si se completa, crear transacción de retiro y recalcular balance
        if (action === 'complete') {
            const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM transactions');
            const refId = 'WTX-' + String(countRows[0].c + 1).padStart(5, '0');

            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
                 VALUES (?, 'withdraw', ?, ?, ?, NOW())`,
                [wr.user_id, wr.amount, `Retiro aprobado — Ref: ${wr.ref_id}`, refId]
            );

            // Recalcular balance
            const [inRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions 
                 WHERE user_id = ? AND type IN ('deposit', 'payment', 'interest', 'profit', 'investment_return', 'investment_withdrawal')`,
                [wr.user_id]
            );
            const [outRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('withdraw')`,
                [wr.user_id]
            );
            const newBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));
            const today = new Date().toISOString().slice(0, 10);

            const [existing] = await connection.execute(
                `SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`, [wr.user_id, today]
            );
            if (existing.length > 0) {
                await connection.execute(`UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`, [newBalance, wr.user_id, today]);
            } else {
                await connection.execute(`INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`, [wr.user_id, newBalance, today]);
            }
        }

        await connection.commit();

        const statusLabels = { approved: 'aprobada', rejected: 'rechazada', completed: 'completada' };
        res.json({
            message: `Solicitud ${statusLabels[newStatus]}`,
            status: newStatus,
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error procesando retiro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};
