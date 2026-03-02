const { pool } = require('../config/database');

// GET /api/admin/stats — Estadísticas generales
exports.getStats = async (req, res) => {
    try {
        const [balanceRows] = await pool.execute(
            `SELECT COALESCE(SUM(t.amount),0) as total FROM transactions t WHERE t.type IN ('deposit','payment')`
        );
        const [withdrawRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type = 'withdraw'`
        );
        const [loanRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type = 'loan'`
        );
        res.json({
            totalBalance: parseFloat(balanceRows[0].total) - parseFloat(withdrawRows[0].total),
            totalWithdrawals: parseFloat(withdrawRows[0].total),
            totalLoans: parseFloat(loanRows[0].total),
        });
    } catch (error) {
        console.error('Error stats:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// GET /api/admin/transactions/recent — Últimas 30 transacciones con nombre de usuario
exports.getRecentTransactions = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT t.*, u.full_name as user_name 
             FROM transactions t 
             LEFT JOIN users u ON t.user_id = u.id 
             ORDER BY t.created_at DESC 
             LIMIT 30`
        );
        res.json(rows);
    } catch (error) {
        console.error('Error recent transactions:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/investments — Crear inversión
exports.createInvestment = async (req, res) => {
    try {
        const { userId, type, amount, annualRate, startDate, status } = req.body;
        if (!userId || !type || !amount || !annualRate) {
            return res.status(400).json({ error: 'userId, type, amount y annualRate son requeridos' });
        }
        const [result] = await pool.execute(
            `INSERT INTO investments (user_id, type, amount, annual_rate, start_date, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, type, amount, annualRate, startDate || new Date().toISOString().split('T')[0], status || 'active']
        );
        res.status(201).json({ message: 'Inversión creada', id: result.insertId });
    } catch (error) {
        console.error('Error creando inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════
// Función auxiliar: Recalcular balance de un usuario
// ══════════════════════════════════════════════════
async function recalculateAndSaveBalance(connection, userId) {
    const [inRows] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total 
         FROM transactions 
         WHERE user_id = ? AND type IN ('deposit', 'payment', 'interest', 'profit', 'investment_return', 'investment_withdrawal')`,
        [userId]
    );
    const [outRows] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total 
         FROM transactions 
         WHERE user_id = ? AND type IN ('withdraw')`,
        [userId]
    );

    const totalIn = parseFloat(inRows[0].total);
    const totalOut = parseFloat(outRows[0].total);
    const newBalance = Math.max(0, totalIn - totalOut);

    const today = new Date().toISOString().slice(0, 10);

    const [existing] = await connection.execute(
        `SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`,
        [userId, today]
    );

    if (existing.length > 0) {
        await connection.execute(
            `UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`,
            [newBalance, userId, today]
        );
    } else {
        await connection.execute(
            `INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`,
            [userId, newBalance, today]
        );
    }

    return newBalance;
}

// POST /api/admin/transactions — Crear transacción (+ auto actualiza balance_history)
exports.createTransaction = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { userId, type, amount, description, date } = req.body;
        if (!userId || !type || !amount) {
            return res.status(400).json({ error: 'userId, type y amount son requeridos' });
        }

        const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM transactions');
        const refId = 'TX-' + String(countRows[0].c + 1).padStart(5, '0');

        const dateObj = date ? new Date(date) : new Date();
        const createdAt = dateObj.toISOString().slice(0, 19).replace('T', ' ');

        const [result] = await connection.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, type, amount, description || '', refId, createdAt]
        );

        const newBalance = await recalculateAndSaveBalance(connection, userId);

        await connection.commit();

        res.status(201).json({
            message: 'Transacción creada',
            id: result.insertId,
            refId,
            newBalance,
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error creando transacción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ══════════════════════════════════════════════════════════════════
// POST /api/admin/investments/:investmentId/return — Registrar rendimiento mensual SDTC
// Este es el endpoint CLAVE para que las ganancias aparezcan en el dashboard del usuario
// ══════════════════════════════════════════════════════════════════
exports.registerInvestmentReturn = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const investmentId = req.params.investmentId;
        const { rate, periodMonth, notes } = req.body;

        // rate = porcentaje mensual (ej: 3.5 para 3.5%)
        // periodMonth = mes del rendimiento (ej: "2026-03-01")

        if (!rate || !periodMonth) {
            return res.status(400).json({ error: 'rate y periodMonth son requeridos' });
        }

        if (rate < 0 || rate > 100) {
            return res.status(400).json({ error: 'La tasa debe estar entre 0 y 100' });
        }

        // 1. Obtener la inversión
        const [invRows] = await connection.execute(
            `SELECT id, user_id, amount, status, type FROM investments WHERE id = ?`,
            [investmentId]
        );

        if (!invRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const investment = invRows[0];

        if (investment.status !== 'active') {
            await connection.rollback();
            return res.status(400).json({ error: 'La inversión no está activa' });
        }

        // 2. Verificar que no exista ya un rendimiento para ese mes
        const [existingReturn] = await connection.execute(
            `SELECT id FROM investment_returns WHERE investment_id = ? AND period_month = ?`,
            [investmentId, periodMonth]
        );

        if (existingReturn.length > 0) {
            await connection.rollback();
            return res.status(400).json({ error: `Ya existe un rendimiento registrado para el mes ${periodMonth}` });
        }

        // 3. Calcular ganancia: capital * (tasa / 100)
        const capitalBase = parseFloat(investment.amount);
        const grossAmountEarned = Math.round(capitalBase * (rate / 100));

        // 3b. Verificar si el usuario tiene referidor → descontar 5% de comisión
        let referralCommission = 0;
        let referrerId = null;
        const [refRows] = await connection.execute('SELECT referred_by FROM users WHERE id = ?', [investment.user_id]);
        if (refRows.length && refRows[0].referred_by) {
            referrerId = refRows[0].referred_by;
            referralCommission = Math.round(grossAmountEarned * 0.05);
        }
        const amountEarned = grossAmountEarned - referralCommission; // El usuario recibe el neto

        // 4. Insertar en investment_returns
        const [returnResult] = await connection.execute(
            `INSERT INTO investment_returns (investment_id, user_id, period_month, rate_applied, amount_earned, status, notes)
             VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
            [investmentId, investment.user_id, periodMonth, rate, amountEarned, notes || `Rendimiento ${rate}% mes ${periodMonth}${referralCommission ? ' (neto -5% referido)' : ''}`]
        );

        // 5. Crear transacción asociada para que aparezca en movimientos
        const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM transactions');
        const refId = 'RET-' + String(countRows[0].c + 1).padStart(5, '0');

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at)
             VALUES (?, ?, 'investment_return', ?, ?, ?, NOW())`,
            [
                investment.user_id,
                investmentId,
                amountEarned,
                `Rendimiento SDTC ${rate}% — ${periodMonth} — Capital: $${capitalBase.toLocaleString('es-CO')}${referralCommission ? ' (neto, -$' + referralCommission.toLocaleString('es-CO') + ' comisión referido)' : ''}`,
                refId,
            ]
        );

        // 5b. Si hay comisión de referido, crear transacción para el referidor
        let referralRefId = null;
        if (referrerId && referralCommission >= 100) {
            referralRefId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

            // Registrar en tabla de comisiones
            try {
                await connection.execute(
                    `INSERT INTO referral_commissions (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id) 
                     VALUES (?, ?, 'investment_return', ?, ?, 0.05, ?, 'paid', ?)`,
                    [referrerId, investment.user_id, returnResult.insertId, grossAmountEarned, referralCommission, referralRefId]
                );
            } catch(e) { console.error('Error registrando comisión en tabla:', e.message); }

            // Crear transacción de ganancia para el referidor
            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'profit', ?, ?, ?, NOW())`,
                [referrerId, referralCommission, `Comisión referido — 5% de rendimiento SDTC`, referralRefId]
            );

            // Recalcular balance del referidor
            const referrerBalance = await recalculateAndSaveBalance(connection, referrerId);
        }

        // 6. Recalcular balance del usuario (la ganancia se suma al balance disponible)
        const newBalance = await recalculateAndSaveBalance(connection, investment.user_id);

        await connection.commit();

        res.status(201).json({
            message: `Rendimiento registrado exitosamente${referralCommission ? ' (5% comisión referido descontada)' : ''}`,
            return: {
                id: returnResult.insertId,
                investmentId,
                userId: investment.user_id,
                periodMonth,
                rate,
                grossAmountEarned,
                referralCommission,
                amountEarned,
                capitalBase,
                refId,
                newBalance,
                referral: referrerId ? { referrerId, commission: referralCommission, refId: referralRefId } : null,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error registrando rendimiento:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/admin/investments/active — Listar inversiones activas (para el panel admin)
// ══════════════════════════════════════════════════════════════════
exports.getActiveInvestments = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT i.id, i.user_id, i.type, i.amount, i.start_date, i.end_date, i.lock_end_date,
                    i.min_monthly_rate, i.max_monthly_rate, i.status, i.created_at,
                    u.full_name as user_name, u.email as user_email
             FROM investments i
             LEFT JOIN users u ON i.user_id = u.id
             WHERE i.status IN ('active', 'pending_deposit')
             ORDER BY i.created_at DESC`
        );

        // Para cada inversión, traer rendimientos ya registrados
        const results = await Promise.all(
            rows.map(async (inv) => {
                const [returns] = await pool.execute(
                    `SELECT period_month, rate_applied, amount_earned, status
                     FROM investment_returns WHERE investment_id = ? ORDER BY period_month ASC`,
                    [inv.id]
                );
                const totalEarned = returns.reduce((sum, r) => sum + parseFloat(r.amount_earned), 0);

                return {
                    id: inv.id,
                    userId: inv.user_id,
                    userName: inv.user_name,
                    userEmail: inv.user_email,
                    type: inv.type,
                    amount: parseFloat(inv.amount),
                    startDate: inv.start_date,
                    endDate: inv.end_date,
                    lockEndDate: inv.lock_end_date,
                    minMonthlyRate: parseFloat(inv.min_monthly_rate || 0),
                    maxMonthlyRate: parseFloat(inv.max_monthly_rate || 0),
                    status: inv.status,
                    totalEarned,
                    returnsCount: returns.length,
                    returns: returns.map(r => ({
                        month: r.period_month,
                        rate: parseFloat(r.rate_applied),
                        earned: parseFloat(r.amount_earned),
                        status: r.status,
                    })),
                };
            })
        );

        res.json(results);
    } catch (error) {
        console.error('Error listando inversiones activas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/balance — Registrar balance (manual)
exports.recordBalance = async (req, res) => {
    try {
        const { userId, balance, date } = req.body;
        if (!userId || balance === undefined) {
            return res.status(400).json({ error: 'userId y balance son requeridos' });
        }
        const [result] = await pool.execute(
            `INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`,
            [userId, balance, (() => { const d = date ? new Date(date) : new Date(); return d.toISOString().slice(0, 10); })()]
        );
        res.status(201).json({ message: 'Balance registrado', id: result.insertId });
    } catch (error) {
        console.error('Error registrando balance:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/recalculate-balance/:userId
exports.recalculateBalance = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const userId = req.params.userId;
        const newBalance = await recalculateAndSaveBalance(connection, userId);
        await connection.commit();
        res.json({ message: 'Balance recalculado', userId, newBalance });
    } catch (error) {
        await connection.rollback();
        console.error('Error recalculando balance:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// POST /api/admin/recalculate-all-balances
exports.recalculateAllBalances = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [users] = await connection.execute(
            `SELECT DISTINCT user_id FROM transactions`
        );

        const results = [];
        for (const row of users) {
            const newBalance = await recalculateAndSaveBalance(connection, row.user_id);
            results.push({ userId: row.user_id, balance: newBalance });
        }

        await connection.commit();
        res.json({ message: `Balances recalculados para ${results.length} usuarios`, results });
    } catch (error) {
        await connection.rollback();
        console.error('Error recalculando todos los balances:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// GET /api/admin/users/:id/details
exports.getUserDetails = async (req, res) => {
    try {
        const userId = req.params.id;
        const [user] = await pool.execute(
            `SELECT id, email, full_name, phone, document_number, role, monthly_goal, created_at FROM users WHERE id = ? AND is_active = 1`, [userId]
        );
        if (!user.length) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [investments] = await pool.execute(`SELECT * FROM investments WHERE user_id = ? ORDER BY start_date DESC`, [userId]);
        const [transactions] = await pool.execute(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [userId]);
        const [balanceHistory] = await pool.execute(`SELECT * FROM balance_history WHERE user_id = ? ORDER BY snapshot_date ASC`, [userId]);

        res.json({ user: user[0], investments, transactions, balanceHistory });
    } catch (error) {
        console.error('Error detalles:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// DELETE /api/admin/investments/:id
exports.deleteInvestment = async (req, res) => {
    try {
        await pool.execute('DELETE FROM investments WHERE id = ?', [req.params.id]);
        res.json({ message: 'Inversión eliminada' });
    } catch (error) { res.status(500).json({ error: 'Error interno' }); }
};

// DELETE /api/admin/transactions/:id
exports.deleteTransaction = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [txRows] = await connection.execute(
            'SELECT user_id FROM transactions WHERE id = ?', [req.params.id]
        );

        await connection.execute('DELETE FROM transactions WHERE id = ?', [req.params.id]);

        if (txRows.length > 0) {
            await recalculateAndSaveBalance(connection, txRows[0].user_id);
        }

        await connection.commit();
        res.json({ message: 'Transacción eliminada y balance actualizado' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Error interno' });
    } finally {
        connection.release();
    }
};

// POST /api/admin/investments/:id/cancel — Admin cancela cualquier inversión
exports.adminCancelInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const invId = req.params.id;
        const { reason } = req.body;

        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND status IN ('active', 'pending_deposit')`,
            [invId]
        );
        if (!invRows.length) {
            return res.status(404).json({ error: 'Inversión no encontrada o ya completada/cancelada' });
        }
        const inv = invRows[0];

        // Cambiar a cancelled
        await connection.execute(
            `UPDATE investments SET status = 'cancelled', notes = CONCAT(IFNULL(notes,''), ' | ADMIN CANCEL: ${(reason || 'Sin motivo').replace(/'/g, "''")}') WHERE id = ?`,
            [invId]
        );

        // Eliminar transacciones de inversión asociadas
        await connection.execute(
            `DELETE FROM transactions WHERE investment_id = ? AND type = 'investment'`,
            [invId]
        );

        // Recalcular balance del usuario
        await recalculateAndSaveBalance(connection, inv.user_id);

        await connection.commit();
        res.json({ message: 'Inversión cancelada por admin. Capital devuelto al usuario.', userId: inv.user_id, amount: parseFloat(inv.amount) });
    } catch (error) {
        await connection.rollback();
        console.error('Error admin cancel investment:', error);
        res.status(500).json({ error: 'Error interno' });
    } finally {
        connection.release();
    }
};

// POST /api/admin/users/:id/toggle-block — Bloquear/Desbloquear usuario
exports.toggleBlockUser = async (req, res) => {
    try {
        const userId = req.params.id;
        const { reason } = req.body;

        const [userRows] = await pool.execute(`SELECT id, status, role FROM users WHERE id = ?`, [userId]);
        if (!userRows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (userRows[0].role === 'admin') return res.status(400).json({ error: 'No se puede bloquear a un administrador' });

        const currentStatus = userRows[0].status;
        const newStatus = currentStatus === 'blocked' ? 'active' : 'blocked';

        await pool.execute(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, userId]);

        // Si se bloquea, invalidar sesiones (opcional: se podría agregar columna blocked_at)
        if (newStatus === 'blocked' && reason) {
            await pool.execute(
                `UPDATE users SET notes = CONCAT(IFNULL(notes,''), '\nBLOQUEADO: ${reason.replace(/'/g, "''")} — ${new Date().toISOString().slice(0,16)}') WHERE id = ?`,
                [userId]
            );
        }

        res.json({ message: `Usuario ${newStatus === 'blocked' ? 'bloqueado' : 'desbloqueado'}`, status: newStatus });
    } catch (error) {
        console.error('Error toggle block:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};
