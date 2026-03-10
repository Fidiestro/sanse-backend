// ══════════════════════════════════════════════════════════════
// controllers/adminController.js — Sanse Capital
// FIXES:
//  1. Usa balanceHelper centralizado (fuente única de verdad)
//  2. getStats ahora incluye TODOS los tipos de ingreso/egreso
//  3. createTransaction valida tipos de transacción
//  4. editUser valida que referredBy exista en la DB
//  5. registerInvestmentReturn usa refId basado en timestamp (sin colisión)
// ══════════════════════════════════════════════════════════════
const { pool } = require('../config/database');
const { auditLog } = require('../utils/helpers');
const { recalculateAndSaveBalance, isValidTransactionType, INFLOW_TYPES, OUTFLOW_TYPES } = require('../utils/balanceHelper');

// GET /api/admin/stats — Estadísticas generales
// FIX: Ahora usa los mismos tipos que balanceHelper para consistencia
exports.getStats = async (req, res) => {
    try {
        const inflowPlaceholders = INFLOW_TYPES.map(() => '?').join(',');
        const outflowPlaceholders = OUTFLOW_TYPES.map(() => '?').join(',');

        const [inRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type IN (${inflowPlaceholders})`,
            [...INFLOW_TYPES]
        );
        const [outRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type IN (${outflowPlaceholders})`,
            [...OUTFLOW_TYPES]
        );
        const [loanRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'loan'`
        );
        const [withdrawRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'withdraw'`
        );

        res.json({
            totalBalance:     parseFloat(inRows[0].total) - parseFloat(outRows[0].total),
            totalWithdrawals: parseFloat(withdrawRows[0].total),
            totalLoans:       parseFloat(loanRows[0].total),
        });
    } catch (error) {
        console.error('Error stats:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// GET /api/admin/transactions/recent  (mantiene compatibilidad — últimas 30)
exports.getRecentTransactions = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT t.*, u.full_name as user_name 
             FROM transactions t LEFT JOIN users u ON t.user_id = u.id 
             ORDER BY t.created_at DESC LIMIT 30`
        );
        res.json(rows);
    } catch (error) {
        console.error('Error recent transactions:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// GET /api/admin/transactions/all — TODAS con filtros + paginación
// Query params: page, limit, type, userId, search, dateFrom, dateTo
exports.getAllTransactions = async (req, res) => {
    try {
        const page     = Math.max(1, parseInt(req.query.page)  || 1);
        const limit    = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
        const offset   = (page - 1) * limit;
        const type     = req.query.type     || '';
        const userId   = req.query.userId   || '';
        const search   = req.query.search   || '';
        const dateFrom = req.query.dateFrom || '';   // YYYY-MM-DD
        const dateTo   = req.query.dateTo   || '';   // YYYY-MM-DD

        const conditions = [];
        const params     = [];

        if (type)     { conditions.push('t.type = ?');              params.push(type); }
        if (userId)   { conditions.push('t.user_id = ?');           params.push(parseInt(userId)); }
        if (dateFrom) { conditions.push('DATE(t.created_at) >= ?'); params.push(dateFrom); }
        if (dateTo)   { conditions.push('DATE(t.created_at) <= ?'); params.push(dateTo); }
        if (search) {
            conditions.push('(u.full_name LIKE ? OR t.description LIKE ? OR t.ref_id LIKE ? OR CAST(t.id AS CHAR) LIKE ?)');
            const like = `%${search}%`;
            params.push(like, like, like, like);
        }

        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        // Total para paginación
        const [countRows] = await pool.execute(
            `SELECT COUNT(*) as total 
             FROM transactions t LEFT JOIN users u ON t.user_id = u.id 
             ${where}`,
            params
        );
        const total = parseInt(countRows[0].total);

        // Datos paginados
        const [rows] = await pool.execute(
            `SELECT t.*, u.full_name as user_name 
             FROM transactions t LEFT JOIN users u ON t.user_id = u.id 
             ${where}
             ORDER BY t.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.json({
            transactions: rows,
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
        });
    } catch (error) {
        console.error('Error getAllTransactions:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/investments — Crear inversión manual
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

// POST /api/admin/transactions — Crear transacción (+ auto actualiza balance_history)
// FIX: Ahora valida que el tipo de transacción sea reconocido por el sistema
exports.createTransaction = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { userId, type, amount, description, date } = req.body;
        if (!userId || !type || !amount) return res.status(400).json({ error: 'userId, type y amount son requeridos' });

        // FIX: Validar tipo de transacción
        if (!isValidTransactionType(type)) {
            return res.status(400).json({
                error: `Tipo de transacción inválido: "${type}". Tipos válidos: deposit, payment, interest, profit, investment_return, investment_withdrawal, loan, withdraw, investment`,
            });
        }

        const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM transactions');
        const refId = 'TX-' + String(countRows[0].c + 1).padStart(5, '0');
        const dateObj   = date ? new Date(date) : new Date();
        const createdAt = dateObj.toISOString().slice(0, 19).replace('T', ' ');

        const [result] = await connection.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, type, amount, description || '', refId, createdAt]
        );

        // FIX: Usa balanceHelper centralizado
        const newBalance = await recalculateAndSaveBalance(connection, userId);
        await connection.commit();

        res.status(201).json({ message: 'Transacción creada', id: result.insertId, refId, newBalance });
    } catch (error) {
        await connection.rollback();
        console.error('Error creando transacción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// POST /api/admin/investments/:investmentId/return — Registrar rendimiento mensual CDTC
// FIX: refId ahora usa timestamp+random en lugar de COUNT(*) para evitar colisiones
exports.registerInvestmentReturn = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const investmentId = req.params.investmentId;
        const { rate, periodMonth, notes } = req.body;

        if (!rate || !periodMonth) return res.status(400).json({ error: 'rate y periodMonth son requeridos' });
        if (rate < 0 || rate > 100) return res.status(400).json({ error: 'La tasa debe estar entre 0 y 100' });

        const [invRows] = await connection.execute(
            `SELECT id, user_id, amount, status, type FROM investments WHERE id = ?`, [investmentId]
        );
        if (!invRows.length) { await connection.rollback(); return res.status(404).json({ error: 'Inversión no encontrada' }); }
        const investment = invRows[0];
        if (investment.status !== 'active') { await connection.rollback(); return res.status(400).json({ error: 'La inversión no está activa' }); }

        const [existingReturn] = await connection.execute(
            `SELECT id FROM investment_returns WHERE investment_id = ? AND period_month = ?`, [investmentId, periodMonth]
        );
        if (existingReturn.length > 0) { await connection.rollback(); return res.status(400).json({ error: `Ya existe un rendimiento registrado para el mes ${periodMonth}` }); }

        const capitalBase       = parseFloat(investment.amount);
        const grossAmountEarned = Math.round(capitalBase * (rate / 100));

        let referralCommission = 0;
        let referrerId         = null;
        const [refRows] = await connection.execute('SELECT referred_by FROM users WHERE id = ?', [investment.user_id]);
        if (refRows.length && refRows[0].referred_by) {
            referrerId         = refRows[0].referred_by;
            referralCommission = Math.round(grossAmountEarned * 0.05);
        }
        const amountEarned = grossAmountEarned - referralCommission;

        const [returnResult] = await connection.execute(
            `INSERT INTO investment_returns (investment_id, user_id, period_month, rate_applied, amount_earned, status, notes)
             VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
            [investmentId, investment.user_id, periodMonth, rate, amountEarned, notes || `Rendimiento ${rate}% mes ${periodMonth}${referralCommission ? ' (neto -5% referido)' : ''}`]
        );

        // FIX: refId basado en timestamp+random (sin colisión por concurrencia)
        const refId = 'RET-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at)
             VALUES (?, ?, 'investment_return', ?, ?, ?, NOW())`,
            [investment.user_id, investmentId, amountEarned,
             `Rendimiento CDTC ${rate}% — ${periodMonth} — Capital: $${capitalBase.toLocaleString('es-CO')}${referralCommission ? ' (neto, -$' + referralCommission.toLocaleString('es-CO') + ' comisión referido)' : ''}`,
             refId]
        );

        let referralRefId = null;
        if (referrerId && referralCommission >= 100) {
            referralRefId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            try {
                await connection.execute(
                    `INSERT INTO referral_commissions (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id) 
                     VALUES (?, ?, 'investment_return', ?, ?, 0.05, ?, 'paid', ?)`,
                    [referrerId, investment.user_id, returnResult.insertId, grossAmountEarned, referralCommission, referralRefId]
                );
            } catch (e) { console.error('Error registrando comisión en tabla:', e.message); }

            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'profit', ?, ?, ?, NOW())`,
                [referrerId, referralCommission, `Comisión referido — 5% de rendimiento CDTC`, referralRefId]
            );
            // FIX: Usa balanceHelper centralizado
            await recalculateAndSaveBalance(connection, referrerId);
        }

        // FIX: Usa balanceHelper centralizado
        const newBalance = await recalculateAndSaveBalance(connection, investment.user_id);
        await connection.commit();

        res.status(201).json({
            message: `Rendimiento registrado exitosamente${referralCommission ? ' (5% comisión referido descontada)' : ''}`,
            return: {
                id: returnResult.insertId, investmentId, userId: investment.user_id,
                periodMonth, rate, grossAmountEarned, referralCommission, amountEarned,
                capitalBase, refId, newBalance,
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

// GET /api/admin/investments/active
exports.getActiveInvestments = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT i.id, i.user_id, i.type, i.amount, i.start_date, i.end_date, i.lock_end_date,
                    i.min_monthly_rate, i.max_monthly_rate, i.status, i.created_at,
                    u.full_name as user_name, u.email as user_email
             FROM investments i LEFT JOIN users u ON i.user_id = u.id
             WHERE i.status IN ('active', 'pending_deposit') ORDER BY i.created_at DESC`
        );

        const results = await Promise.all(rows.map(async (inv) => {
            const [returns] = await pool.execute(
                `SELECT period_month, rate_applied, amount_earned, status FROM investment_returns WHERE investment_id = ? ORDER BY period_month ASC`,
                [inv.id]
            );
            const totalEarned = returns.reduce((sum, r) => sum + parseFloat(r.amount_earned), 0);
            return {
                id: inv.id, userId: inv.user_id, userName: inv.user_name, userEmail: inv.user_email,
                type: inv.type, amount: parseFloat(inv.amount),
                startDate: inv.start_date, endDate: inv.end_date, lockEndDate: inv.lock_end_date,
                minMonthlyRate: parseFloat(inv.min_monthly_rate || 0),
                maxMonthlyRate: parseFloat(inv.max_monthly_rate || 0),
                status: inv.status, totalEarned, returnsCount: returns.length,
                returns: returns.map(r => ({ month: r.period_month, rate: parseFloat(r.rate_applied), earned: parseFloat(r.amount_earned), status: r.status })),
            };
        }));

        res.json(results);
    } catch (error) {
        console.error('Error listando inversiones activas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/balance
exports.recordBalance = async (req, res) => {
    try {
        const { userId, balance, date } = req.body;
        if (!userId || balance === undefined) return res.status(400).json({ error: 'userId y balance son requeridos' });
        const snapshotDate = date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
        const [result] = await pool.execute(
            `INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`,
            [userId, balance, snapshotDate]
        );
        res.status(201).json({ message: 'Balance registrado', id: result.insertId });
    } catch (error) {
        console.error('Error registrando balance:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/recalculate-balance/:userId
// FIX: Usa balanceHelper centralizado
exports.recalculateBalance = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const newBalance = await recalculateAndSaveBalance(connection, req.params.userId);
        await connection.commit();
        res.json({ message: 'Balance recalculado', userId: req.params.userId, newBalance });
    } catch (error) {
        await connection.rollback();
        console.error('Error recalculando balance:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// POST /api/admin/recalculate-all-balances
// FIX: Usa balanceHelper centralizado
exports.recalculateAllBalances = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [users] = await connection.execute(`SELECT DISTINCT user_id FROM transactions`);
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

        const [investments]    = await pool.execute(`SELECT * FROM investments WHERE user_id = ? ORDER BY start_date DESC`, [userId]);
        const [transactions]   = await pool.execute(`SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [userId]);
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
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// DELETE /api/admin/transactions/:id
// FIX: Usa balanceHelper centralizado
exports.deleteTransaction = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [txRows] = await connection.execute('SELECT user_id FROM transactions WHERE id = ?', [req.params.id]);
        await connection.execute('DELETE FROM transactions WHERE id = ?', [req.params.id]);
        if (txRows.length > 0) await recalculateAndSaveBalance(connection, txRows[0].user_id);
        await connection.commit();
        res.json({ message: 'Transacción eliminada y balance actualizado' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Error interno' });
    } finally {
        connection.release();
    }
};

// POST /api/admin/investments/:id/cancel
exports.adminCancelInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const invId  = req.params.id;
        const reason = req.body.reason || 'Sin motivo';

        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND status IN ('active', 'pending_deposit')`, [invId]
        );
        if (!invRows.length) return res.status(404).json({ error: 'Inversión no encontrada o ya completada/cancelada' });
        const inv = invRows[0];

        await connection.execute(
            `UPDATE investments SET status = 'cancelled', notes = CONCAT(IFNULL(notes,''), ?) WHERE id = ?`,
            [` | ADMIN CANCEL: ${reason}`, invId]
        );

        await connection.execute(
            `DELETE FROM transactions WHERE investment_id = ? AND type = 'investment'`, [invId]
        );

        // FIX: Usa balanceHelper centralizado
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

// POST /api/admin/users/:id/toggle-block
exports.toggleBlockUser = async (req, res) => {
    try {
        const userId = req.params.id;
        const reason = req.body.reason || '';

        const [userRows] = await pool.execute(`SELECT id, status, role FROM users WHERE id = ?`, [userId]);
        if (!userRows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (userRows[0].role === 'admin') return res.status(400).json({ error: 'No se puede bloquear a un administrador' });

        const currentStatus = userRows[0].status;
        const newStatus     = currentStatus === 'blocked' ? 'active' : 'blocked';

        await pool.execute(`UPDATE users SET status = ? WHERE id = ?`, [newStatus, userId]);

        if (newStatus === 'blocked' && reason) {
            const note = `\nBLOQUEADO: ${reason} — ${new Date().toISOString().slice(0, 16)}`;
            await pool.execute(
                `UPDATE users SET notes = CONCAT(IFNULL(notes,''), ?) WHERE id = ?`,
                [note, userId]
            );
        }

        res.json({ message: `Usuario ${newStatus === 'blocked' ? 'bloqueado' : 'desbloqueado'}`, status: newStatus });
    } catch (error) {
        console.error('Error toggle block:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// POST /api/admin/loans/create — Crear préstamo directo
// FIX: Usa balanceHelper centralizado
exports.adminCreateLoan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { userId, amount, termMonths, monthlyRate, purpose, notes, startDate } = req.body;

        if (!userId || !amount || !termMonths || !monthlyRate)
            return res.status(400).json({ error: 'userId, amount, termMonths y monthlyRate son requeridos' });

        const parsedAmount = parseFloat(amount);
        const parsedRate   = parseFloat(monthlyRate);
        const parsedTerm   = parseInt(termMonths);

        if (parsedAmount < 100000) return res.status(400).json({ error: 'Monto mínimo: $100.000 COP' });
        if (parsedRate < 1 || parsedRate > 20) return res.status(400).json({ error: 'Tasa entre 1% y 20%' });

        const [userRows] = await connection.execute(`SELECT id, full_name FROM users WHERE id = ?`, [userId]);
        if (!userRows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

        const loanStart = startDate ? new Date(startDate) : new Date();
        const dueDate   = new Date(loanStart);
        dueDate.setMonth(dueDate.getMonth() + parsedTerm);
        const fmt = d => d.toISOString().slice(0, 10);

        const refId = 'LADM-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        const [result] = await connection.execute(
            `INSERT INTO loan_requests
             (user_id, amount, term_months, purpose, credit_score, status, ref_id,
              approved_amount, approved_rate, monthly_rate, start_date, due_date, admin_notes, processed_at, processed_by)
             VALUES (?, ?, ?, ?, 999, 'active', ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [userId, parsedAmount, parsedTerm,
             purpose || `Préstamo ${parsedTerm} mes${parsedTerm > 1 ? 'es' : ''} — Admin`,
             refId, parsedAmount, parsedRate, parsedRate,
             fmt(loanStart), fmt(dueDate),
             notes || 'Creado directamente por administrador',
             req.user?.id || null]
        );

        await connection.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'loan', ?, ?, ?, ?)`,
            [userId, parsedAmount,
             purpose || `Préstamo SANSE — ${parsedTerm} mes${parsedTerm > 1 ? 'es' : ''} al ${parsedRate}% mensual`,
             refId, fmt(loanStart)]
        );

        // FIX: Usa balanceHelper centralizado
        const newBalance = await recalculateAndSaveBalance(connection, userId);

        await connection.commit();

        res.status(201).json({
            message: `Préstamo de $${parsedAmount.toLocaleString('es-CO')} COP creado para ${userRows[0].full_name}`,
            loan: { id: result.insertId, refId, amount: parsedAmount, termMonths: parsedTerm, monthlyRate: parsedRate, dueDate: fmt(dueDate), newBalance }
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error adminCreateLoan:', error);
        res.status(500).json({ error: 'Error interno: ' + error.message });
    } finally {
        connection.release();
    }
};

// POST /api/admin/users/:id/edit
// FIX: Ahora valida que referredBy exista en la DB
exports.editUser = async (req, res) => {
    try {
        const userId = req.params.id;
        const { fullName, email, phone, documentNumber, role, status, password, referredBy } = req.body;

        if (!fullName || !email) return res.status(400).json({ error: 'Nombre y email son obligatorios' });

        const [userRows] = await pool.execute(`SELECT id FROM users WHERE id = ?`, [userId]);
        if (!userRows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [emailCheck] = await pool.execute(`SELECT id FROM users WHERE email = ? AND id != ?`, [email.toLowerCase().trim(), userId]);
        if (emailCheck.length) return res.status(400).json({ error: 'Ese email ya está en uso' });

        // Calcular referrerId de forma robusta + FIX: validar que exista
        let referrerId = null;
        const refRaw = referredBy;
        if (refRaw !== null && refRaw !== undefined && refRaw !== 'none' && refRaw !== '') {
            const ref = parseInt(refRaw, 10);
            if (!isNaN(ref) && ref > 0 && ref !== parseInt(userId)) {
                // FIX: Verificar que el usuario referidor exista en la DB
                const [refExists] = await pool.execute(`SELECT id FROM users WHERE id = ? AND is_active = 1`, [ref]);
                if (!refExists.length) {
                    return res.status(400).json({ error: `El usuario referidor con ID ${ref} no existe` });
                }
                referrerId = ref;
            }
        }

        const fields = ['full_name=?', 'email=?', 'phone=?', 'document_number=?', 'role=?', 'status=?', 'referred_by=?'];
        const values = [
            fullName.trim(), email.toLowerCase().trim(),
            phone || null, documentNumber || null,
            role || 'client', status || 'active',
            referrerId
        ];

        if (password && password.length >= 8) {
            const bcrypt = require('bcryptjs');
            fields.push('password_hash=?');
            values.push(await bcrypt.hash(password, 12));
        }

        values.push(userId);
        await pool.execute(`UPDATE users SET ${fields.join(',')} WHERE id = ?`, values);

        res.json({ message: 'Usuario actualizado correctamente' });
    } catch (error) {
        console.error('Error editUser:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};