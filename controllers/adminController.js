// ══════════════════════════════════════════════════════════════
// controllers/adminController.js — Sanse Capital
// FIXES PREVIOS:
//  1. Usa balanceHelper centralizado (fuente única de verdad)
//  2. getStats ahora incluye TODOS los tipos de ingreso/egreso
//  3. createTransaction valida tipos de transacción
//  4. editUser valida que referredBy exista en la DB
//  5. registerInvestmentReturn usa refId basado en timestamp (sin colisión)
//
// FIXES NUEVOS (panel admin):
//  6. listAllUsers       → GET  /admin/users
//  7. createUserByAdmin  → POST /admin/users/create
//  8. savePoolConfig     → POST /admin/pool/config
//  9. registerInvestmentReturn: normaliza periodMonth "YYYY-MM" → "YYYY-MM-DD"
//     (fix Error: Incorrect date value para columna DATE)
// 10. registerInvestmentReturn: UNIFICADO Pool + CDTC.
//     Ambos acumulan en withdrawable_earnings, no acreditan balance.
//     Comisiones se procesan al hacer claim:
//       - Pool: 20% Sanse + 5% referido (si aplica)
//       - CDTC: solo 5% referido (si aplica)
// ══════════════════════════════════════════════════════════════
const { pool } = require('../config/database');
const { auditLog } = require('../utils/helpers');
const { recalculateAndSaveBalance, isValidTransactionType, INFLOW_TYPES, OUTFLOW_TYPES } = require('../utils/balanceHelper');

// GET /api/admin/stats — Estadísticas generales
// FIX: Ahora usa los mismos tipos que balanceHelper para consistencia
exports.getStats = async (req, res) => {
    try {
        // Total usuarios
        const [userRows] = await pool.execute('SELECT COUNT(*) as total FROM users');
        const totalUsers = parseInt(userRows[0].total);

        // Balance global (inflows - outflows)
        const inflowPH = INFLOW_TYPES.map(() => '?').join(',');
        const outflowPH = OUTFLOW_TYPES.map(() => '?').join(',');
        const [inRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type IN (${inflowPH})`,
            [...INFLOW_TYPES]
        );
        const [outRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type IN (${outflowPH})`,
            [...OUTFLOW_TYPES]
        );
        const totalBalance = parseFloat(inRows[0].total) - parseFloat(outRows[0].total);

        // Total depositado
        const [depRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'deposit'`
        );

        // Total invertido activo
        const [invRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM investments WHERE status IN ('active', 'pending_deposit')`
        );

        // Ganancias pagadas
        const [earnRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type IN ('investment_return', 'profit', 'interest')`
        );

        // Retiros totales
        const [wrRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'withdraw'`
        );

        // Depósitos pendientes
        const [pendDep] = await pool.execute(
            `SELECT COUNT(*) as total FROM deposit_requests WHERE status = 'pending'`
        );

        // Retiros pendientes
        const [pendWr] = await pool.execute(
            `SELECT COUNT(*) as total FROM withdrawal_requests WHERE status IN ('pending', 'approved')`
        );

        // Préstamos
        const [loanRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'loan'`
        );

        res.json({
            totalUsers,
            totalBalance,
            totalDeposited:      parseFloat(depRows[0].total),
            totalInvested:       parseFloat(invRows[0].total),
            activeInvestments:   parseInt(invRows[0].count),
            totalEarnings:       parseFloat(earnRows[0].total),
            totalWithdrawals:    parseFloat(wrRows[0].total),
            totalLoans:          parseFloat(loanRows[0].total),
            pendingDeposits:     parseInt(pendDep[0].total),
            pendingWithdrawals:  parseInt(pendWr[0].total),
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
            [...params, String(limit), String(offset)]
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

        // FIX: el input <input type="month"> manda "YYYY-MM" pero la columna
        // period_month es DATE en MySQL, que exige "YYYY-MM-DD".
        // Normalizamos a primer día del mes. Si ya viene en formato fecha
        // completo lo dejamos tal cual.
        let periodMonthDB = String(periodMonth).trim();
        if (/^\d{4}-\d{2}$/.test(periodMonthDB)) {
            periodMonthDB = periodMonthDB + '-01';
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(periodMonthDB)) {
            return res.status(400).json({ error: `Formato de mes inválido: "${periodMonth}". Usa YYYY-MM o YYYY-MM-DD` });
        }

        const [invRows] = await connection.execute(
            `SELECT id, user_id, amount, status, type FROM investments WHERE id = ?`, [investmentId]
        );
        if (!invRows.length) { await connection.rollback(); return res.status(404).json({ error: 'Inversión no encontrada' }); }
        const investment = invRows[0];
        if (investment.status !== 'active') { await connection.rollback(); return res.status(400).json({ error: 'La inversión no está activa' }); }

        // Tipo de inversión: Pool (Fondo DGP) vs LP COP (CDTC).
        // AMBOS se registran manualmente con la tasa que escribe el admin.
        const invType = (investment.type || '').toLowerCase();
        const isPool  = invType === 'pool';
        const label   = isPool ? 'Fondo DGP' : 'LP COP';

        const [existingReturn] = await connection.execute(
            `SELECT id FROM investment_returns WHERE investment_id = ? AND period_month = ?`, [investmentId, periodMonthDB]
        );
        if (existingReturn.length > 0) { await connection.rollback(); return res.status(400).json({ error: `Ya existe un rendimiento registrado para el mes ${periodMonth}` }); }

        const capitalBase       = parseFloat(investment.amount);
        const grossAmountEarned = Math.round(capitalBase * (rate / 100));

        // ── Inserción según el tipo, para NO romper el claim de cada producto ──
        // El admin NO acredita al balance al registrar, NO procesa referidos.
        // Los descuentos (Pool 20% + 5% referido; LP COP 5% referido) se aplican
        // cuando el CLIENTE hace claim desde su dashboard.
        //
        //   • Pool (DGP): el claim lee investments.withdrawable_earnings.
        //     → status='paid' + acumula en withdrawable_earnings.
        //   • LP COP: el claim lee investment_returns con status='accrued'.
        //     → status='accrued', SIN tocar withdrawable_earnings.
        let returnResult;
        if (isPool) {
            [returnResult] = await connection.execute(
                `INSERT INTO investment_returns (investment_id, user_id, period_month, rate_applied, amount_earned, status, notes)
                 VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
                [investmentId, investment.user_id, periodMonthDB, rate, grossAmountEarned,
                 notes || `Rendimiento ${label} ${rate}% mes ${periodMonth} — Acumulado para claim`]
            );
            await connection.execute(
                `UPDATE investments
                 SET withdrawable_earnings = COALESCE(withdrawable_earnings, 0) + ?
                 WHERE id = ?`,
                [grossAmountEarned, investmentId]
            );
        } else {
            // LP COP — mismo formato que el devengo manual (status='accrued').
            [returnResult] = await connection.execute(
                `INSERT INTO investment_returns (investment_id, user_id, period_month, rate_applied, amount_earned, status, notes)
                 VALUES (?, ?, ?, ?, ?, 'accrued', ?)`,
                [investmentId, investment.user_id, periodMonthDB, rate, grossAmountEarned,
                 notes || `Rendimiento ${label} ${rate}% mes ${periodMonth} — Acumulado para claim`]
            );
        }

        await connection.commit();
        return res.status(201).json({
            message: `Rendimiento ${label} acumulado ($${grossAmountEarned.toLocaleString('es-CO')}). El cliente verá "Por retirar" en su dashboard.`,
            return: {
                id: returnResult.insertId,
                investmentId,
                userId: investment.user_id,
                periodMonth,
                rate,
                grossAmountEarned,
                accrued: true,
                creditedToBalance: false,
                capitalBase,
                type: invType,
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

// PUT /api/admin/transactions/:id
// Edita una transacción (type, amount, description, date) y recalcula el balance.
// Solo actualiza los campos enviados (aditivo / no destructivo).
exports.editTransaction = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const txId = req.params.id;
        const { type, amount, description, date } = req.body;

        const [rows] = await connection.execute('SELECT user_id FROM transactions WHERE id = ?', [txId]);
        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Transacción no encontrada' });
        }
        const ownerId = rows[0].user_id;

        if (type !== undefined && !isValidTransactionType(type)) {
            await connection.rollback();
            return res.status(400).json({
                error: `Tipo de transacción inválido: "${type}". Tipos válidos: deposit, payment, interest, profit, investment_return, investment_withdrawal, loan, withdraw, investment, fee`,
            });
        }
        if (amount !== undefined && isNaN(Number(amount))) {
            await connection.rollback();
            return res.status(400).json({ error: 'Monto inválido' });
        }

        const sets = [];
        const params = [];
        if (type !== undefined)        { sets.push('type = ?');        params.push(type); }
        if (amount !== undefined)      { sets.push('amount = ?');      params.push(Number(amount)); }
        if (description !== undefined) { sets.push('description = ?'); params.push(description || null); }
        if (date !== undefined && date) {
            const createdAt = new Date(date).toISOString().slice(0, 19).replace('T', ' ');
            sets.push('created_at = ?');
            params.push(createdAt);
        }

        if (!sets.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'No hay cambios para aplicar' });
        }

        params.push(txId);
        await connection.execute(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, params);

        const newBalance = await recalculateAndSaveBalance(connection, ownerId);

        await connection.commit();
        res.json({ message: 'Transacción actualizada y balance recalculado', userId: ownerId, newBalance });
    } catch (error) {
        await connection.rollback();
        console.error('Error editando transacción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
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

// POST /api/admin/investments/:id/revoke
// Revoca una inversión (LP COP o Pool). Marca 'cancelled', limpia los
// rendimientos acumulados y, si refundCapital=true, devuelve el capital
// al balance del usuario (eliminando la transacción 'investment' que lo
// había descontado). Si refundCapital=false, el capital NO se devuelve.
exports.adminRevokeInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const invId = req.params.id;
        const refundCapital = req.body.refundCapital === true || req.body.refundCapital === 'true';
        const notes = (req.body.notes ? String(req.body.notes).slice(0, 120) : '').trim();

        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND status IN ('active', 'pending_deposit')`, [invId]
        );
        if (!invRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Inversión no encontrada o ya cancelada/completada' });
        }
        const inv = invRows[0];

        // 1. Marcar la inversión como cancelada
        const note = ` | ADMIN REVOKE${refundCapital ? ' (capital devuelto)' : ' (sin devolver capital)'}: ${notes || 'sin motivo'} — ${new Date().toISOString().slice(0, 16)}`;
        await connection.execute(
            `UPDATE investments SET status = 'cancelled', notes = CONCAT(IFNULL(notes,''), ?) WHERE id = ?`,
            [note, invId]
        );

        // 2. Limpiar rendimientos acumulados de esta inversión (evita rendimientos fantasma reclamables).
        //    Solo se borran los que aún NO han sido reclamados (accrued); los ya pagados quedan como histórico.
        try {
            await connection.execute(
                `DELETE FROM investment_returns WHERE investment_id = ? AND status = 'accrued'`, [invId]
            );
        } catch (e) { console.warn('[revoke] no se pudieron limpiar investment_returns:', e.message); }

        // 3. Devolver capital si corresponde:
        //    La transacción tipo 'investment' fue la que descontó el capital del balance.
        //    Borrarla hace que, al recalcular, el capital vuelva a estar disponible.
        if (refundCapital) {
            await connection.execute(
                `DELETE FROM transactions WHERE investment_id = ? AND type = 'investment'`, [invId]
            );
        }

        // 4. Recalcular balance (refleja la devolución si la hubo)
        const newBalance = await recalculateAndSaveBalance(connection, inv.user_id);

        // 5. Audit log (no bloquea)
        try {
            await auditLog({
                userId: req.user?.id,
                action: 'investment_revoke',
                entityType: 'investments',
                entityId: invId,
                details: { refundCapital, notes: notes || null, amount: parseFloat(inv.amount), type: inv.type },
                ipAddress: req.ip,
            });
        } catch (e) { console.error('[auditLog revoke]', e.message); }

        await connection.commit();

        res.json({
            message: refundCapital
                ? 'Inversión revocada. Capital devuelto al balance del usuario.'
                : 'Inversión revocada sin devolver capital.',
            userId: inv.user_id,
            amount: parseFloat(inv.amount),
            refundCapital,
            newBalance,
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error admin revoke investment:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
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
// FIX: Soporta préstamos SIN plazo definido (termMonths = 0 / null / 'indefinido')
exports.adminCreateLoan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { userId, amount, termMonths, monthlyRate, purpose, notes, startDate } = req.body;

        if (!userId || !amount || !monthlyRate)
            return res.status(400).json({ error: 'userId, amount y monthlyRate son requeridos' });

        const parsedAmount = parseFloat(amount);
        const parsedRate   = parseFloat(monthlyRate);

        // ── NUEVO: Detectar préstamo sin plazo definido ──
        const isIndefinite = !termMonths
                          || termMonths === 0
                          || termMonths === '0'
                          || termMonths === 'indefinido'
                          || termMonths === 'indefinite';
        const parsedTerm = isIndefinite ? null : parseInt(termMonths);

        if (parsedAmount < 100000) return res.status(400).json({ error: 'Monto mínimo: $100.000 COP' });
        if (parsedRate < 1 || parsedRate > 20) return res.status(400).json({ error: 'Tasa entre 1% y 20%' });
        if (!isIndefinite && (isNaN(parsedTerm) || parsedTerm < 1 || parsedTerm > 60)) {
            return res.status(400).json({ error: 'Plazo debe ser entre 1 y 60 meses, o "indefinido"' });
        }

        const [userRows] = await connection.execute(`SELECT id, full_name FROM users WHERE id = ?`, [userId]);
        if (!userRows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

        const loanStart = startDate ? new Date(startDate) : new Date();
        let dueDate = null;
        if (!isIndefinite) {
            dueDate = new Date(loanStart);
            dueDate.setMonth(dueDate.getMonth() + parsedTerm);
        }
        const fmt = d => d ? d.toISOString().slice(0, 10) : null;

        const refId = 'LADM-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        const purposeText = purpose || (isIndefinite
            ? `Préstamo sin plazo definido — Admin`
            : `Préstamo ${parsedTerm} mes${parsedTerm > 1 ? 'es' : ''} — Admin`);

        const txDesc = isIndefinite
            ? `Préstamo SANSE — Sin plazo definido al ${parsedRate}% mensual`
            : `Préstamo SANSE — ${parsedTerm} mes${parsedTerm > 1 ? 'es' : ''} al ${parsedRate}% mensual`;

        const [result] = await connection.execute(
            `INSERT INTO loan_requests
             (user_id, amount, term_months, purpose, credit_score, status, ref_id,
              approved_amount, approved_rate, monthly_rate, start_date, due_date, admin_notes, processed_at, processed_by)
             VALUES (?, ?, ?, ?, 999, 'active', ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [userId, parsedAmount, parsedTerm,
             purposeText,
             refId, parsedAmount, parsedRate, parsedRate,
             fmt(loanStart), fmt(dueDate),
             notes || 'Creado directamente por administrador',
             req.user?.id || null]
        );

        await connection.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'loan', ?, ?, ?, ?)`,
            [userId, parsedAmount, txDesc, refId, fmt(loanStart)]
        );

        // FIX: Usa balanceHelper centralizado
        const newBalance = await recalculateAndSaveBalance(connection, userId);

        await connection.commit();

        res.status(201).json({
            message: `Préstamo de $${parsedAmount.toLocaleString('es-CO')} COP creado para ${userRows[0].full_name}`,
            loan: {
                id: result.insertId,
                refId,
                amount: parsedAmount,
                termMonths: parsedTerm,
                indefinite: isIndefinite,
                monthlyRate: parsedRate,
                dueDate: fmt(dueDate),
                newBalance
            }
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

// ──────────────────────────────────────────────────────────────
// GET /api/admin/users
// Lista todos los usuarios con balance, total invertido y estado.
// Esto es lo que admin.html necesita para llenar el <select> de
// transacciones, la tabla de usuarios, y el dropdown de préstamos.
// ──────────────────────────────────────────────────────────────
exports.listAllUsers = async (req, res) => {
    try {
        // Una sola query con subconsultas para no hacer N+1.
        // Balance: último snapshot por usuario (o 0 si no tiene).
        // totalInvested: suma de inversiones activas/pendientes.
        const [rows] = await pool.execute(
            `SELECT
                u.id,
                u.email,
                u.full_name,
                u.phone,
                u.document_number,
                u.role,
                u.status,
                u.referral_code,
                u.referred_by,
                u.created_at,
                COALESCE((
                    SELECT bh.amount
                    FROM balance_history bh
                    WHERE bh.user_id = u.id
                    ORDER BY bh.snapshot_date DESC, bh.id DESC
                    LIMIT 1
                ), 0) AS balance,
                COALESCE((
                    SELECT SUM(i.amount)
                    FROM investments i
                    WHERE i.user_id = u.id
                      AND i.status IN ('active', 'pending_deposit')
                ), 0) AS totalInvested
             FROM users u
             WHERE u.is_active = 1
             ORDER BY u.created_at DESC`
        );

        // Convertimos numéricos a Number y agregamos `is_blocked` derivado
        // para que el frontend siga funcionando con su lógica actual.
        const users = rows.map(u => ({
            id: u.id,
            email: u.email,
            full_name: u.full_name,
            phone: u.phone,
            document_number: u.document_number,
            role: u.role,
            status: u.status,
            is_blocked: u.status === 'blocked',
            referral_code: u.referral_code,
            referred_by: u.referred_by,
            created_at: u.created_at,
            balance: parseFloat(u.balance) || 0,
            totalInvested: parseFloat(u.totalInvested) || 0,
        }));

        res.json(users);
    } catch (error) {
        console.error('Error listAllUsers:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ──────────────────────────────────────────────────────────────
// POST /api/admin/users/create
// Crea un usuario directamente desde el panel admin (sin pasar
// por el flujo de registro público + aprobación).
// ──────────────────────────────────────────────────────────────
exports.createUserByAdmin = async (req, res) => {
    try {
        const { fullName, email, password, phone, documentNumber, role } = req.body;

        if (!fullName || !email || !password) {
            return res.status(400).json({ error: 'fullName, email y password son requeridos' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
        }

        // ¿Email ya existe?
        const [existing] = await pool.execute(
            `SELECT id FROM users WHERE email = ?`,
            [email.toLowerCase().trim()]
        );
        if (existing.length) {
            return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
        }

        const bcrypt = require('bcryptjs');
        const passwordHash = await bcrypt.hash(password, 12);

        // Generar referral_code corto y único
        const referralCode = (fullName.replace(/\s+/g, '').slice(0, 4).toUpperCase()
            + Math.random().toString(36).slice(2, 6).toUpperCase());

        const [result] = await pool.execute(
            `INSERT INTO users
             (full_name, email, password_hash, phone, document_number, role, referral_code, status, is_active, email_verified, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, NOW())`,
            [
                fullName.trim(),
                email.toLowerCase().trim(),
                passwordHash,
                phone || null,
                documentNumber || null,
                role || 'client',
                referralCode,
            ]
        );

        // Audit log (si está disponible — no rompe si falla)
        try {
            await auditLog({
                userId: req.user?.id || null,
                action: 'admin_create_user',
                entityType: 'user',
                entityId: result.insertId,
                details: { email: email.toLowerCase().trim(), role: role || 'client' },
                ipAddress: req.ip,
            });
        } catch (e) { /* opcional */ }

        res.status(201).json({
            message: 'Usuario creado exitosamente',
            userId: result.insertId,
            referralCode,
        });
    } catch (error) {
        console.error('Error createUserByAdmin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ──────────────────────────────────────────────────────────────
// POST /api/admin/pool/config
// Guarda la configuración del Pool (APY, capital, distribución, mínimo).
// Antes vivía en routes/pool-routes.js que NO estaba montado.
// ──────────────────────────────────────────────────────────────
exports.savePoolConfig = async (req, res) => {
    try {
        const { monthlyAPY, annualAPY, totalCapital, distribution, minAmount } = req.body;

        const mAPY = parseFloat(monthlyAPY);
        if (!isFinite(mAPY) || mAPY <= 0 || mAPY > 100) {
            return res.status(400).json({ error: 'APY mensual inválido (0-100)' });
        }
        const aAPY = isFinite(parseFloat(annualAPY))
            ? parseFloat(annualAPY)
            : ((Math.pow(1 + mAPY / 100, 12) - 1) * 100);
        const tCap = parseFloat(totalCapital) || 0;
        const dist = parseFloat(distribution);
        if (!isFinite(dist) || dist < 0 || dist > 100) {
            return res.status(400).json({ error: 'Distribución inválida (0-100)' });
        }
        const mAmt = parseFloat(minAmount) || 50000;

        // Upsert: si no hay fila, la crea; si hay, la actualiza.
        const [existing] = await pool.execute(`SELECT id FROM pool_config LIMIT 1`);
        if (existing.length) {
            await pool.execute(
                `UPDATE pool_config
                 SET monthly_apy = ?, annual_apy = ?, total_capital = ?,
                     distribution = ?, min_amount = ?, updated_at = NOW()
                 WHERE id = ?`,
                [mAPY, aAPY, tCap, dist, mAmt, existing[0].id]
            );
        } else {
            await pool.execute(
                `INSERT INTO pool_config (monthly_apy, annual_apy, total_capital, distribution, min_amount, months_tracked, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 0, NOW(), NOW())`,
                [mAPY, aAPY, tCap, dist, mAmt]
            );
        }

        res.json({
            message: 'Configuración del Pool actualizada',
            config: { monthlyAPY: mAPY, annualAPY: aAPY, totalCapital: tCap, distribution: dist, minAmount: mAmt },
        });
    } catch (error) {
        console.error('Error savePoolConfig:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};