const { pool } = require('../config/database');
const { auditLog } = require('../utils/helpers');
const { INFLOW_TYPES, OUTFLOW_TYPES } = require('../utils/balanceHelper');

// ═══════════════════════════════════════════════════════════════════════
// GET /api/investments/available — Productos de inversión disponibles
// ═══════════════════════════════════════════════════════════════════════
exports.getAvailableProducts = async (req, res) => {
    try {
        const products = [
            {
                id: 'cdtc_3m',
                name: 'CDTC 3 Meses',
                durationMonths: 3,
                minMonthlyRate: 2.0,
                maxMonthlyRate: 3.0,
                minAmount: 100000,
                features: ['Plazo fijo de 3 meses', 'Rendimiento mensual variable 2% — 3%', 'Capital bloqueado hasta vencimiento'],
            },
            {
                id: 'cdtc_6m',
                name: 'CDTC 6 Meses',
                durationMonths: 6,
                minMonthlyRate: 2.0,
                maxMonthlyRate: 4.0,
                minAmount: 100000,
                features: ['Plazo fijo de 6 meses', 'Rendimiento mensual variable 2% — 4%', 'Capital bloqueado hasta vencimiento'],
            },
            {
                id: 'cdtc_12m',
                name: 'CDTC 12 Meses',
                durationMonths: 12,
                minMonthlyRate: 3.0,
                maxMonthlyRate: 4.0,
                minAmount: 100000,
                features: ['Plazo fijo de 12 meses', 'Rendimiento mensual variable 3% — 4%', 'Capital bloqueado hasta vencimiento'],
            },
        ];
        res.json(products);
    } catch (error) {
        console.error('Error obteniendo productos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/investments/create — Usuario crea inversión CDTC o POOL
// ═══════════════════════════════════════════════════════════════════════
exports.createUserInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const { productId, type, durationMonths } = req.body;
        const amount = parseFloat(req.body.amount);

        if (!amount || isNaN(amount)) {
            return res.status(400).json({ error: 'amount es requerido' });
        }

        // ============ POOL DE LIQUIDEZ ============
        if (type === 'pool') {
            // Validar monto mínimo
            if (amount < 50000) {
                return res.status(400).json({ error: 'Monto mínimo para Pool: $50,000 COP' });
            }

            // Calcular comisión de entrada (2%)
            const entryFee = Math.round(amount * 0.02);
            const netCapital = amount - entryFee;

            // Fechas (bloqueado 12 meses)
            const startDate = new Date();
            const lockEndDate = new Date(startDate);
            lockEndDate.setMonth(lockEndDate.getMonth() + 12);

            const formatDate = (d) => d.toISOString().slice(0, 10);

            // Verificar balance disponible
            const inflowPH = INFLOW_TYPES.map(() => '?').join(',');
            const outflowPH = OUTFLOW_TYPES.map(() => '?').join(',');
            const [inRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (${inflowPH})`,
                [userId, ...INFLOW_TYPES]
            );
            const [outRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (${outflowPH})`,
                [userId, ...OUTFLOW_TYPES]
            );
            const totalBalance = parseFloat(inRows[0].total) - parseFloat(outRows[0].total);

            const [investedRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit')`,
                [userId]
            );
            const totalInvested = parseFloat(investedRows[0].total);

            const [pendingWithdrawals] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`,
                [userId]
            );
            const pendingWithdrawalAmount = parseFloat(pendingWithdrawals[0].total);

            const availableBalance = Math.max(0, totalBalance - totalInvested - pendingWithdrawalAmount);

            if (amount > availableBalance || availableBalance < amount) {
                return res.status(400).json({
                    error: `Saldo insuficiente. Disponible: $${Math.round(Math.max(0, availableBalance)).toLocaleString('es-CO')} COP`,
                    available: Math.max(0, availableBalance),
                });
            }

            // Crear inversión Pool
            const [result] = await connection.execute(
                `INSERT INTO investments 
                 (user_id, type, amount, net_capital, entry_fee, duration_months, 
                  start_date, lock_end_date, invested_from_balance, status, notes, withdrawable_earnings) 
                 VALUES (?, 'pool', ?, ?, ?, 12, ?, ?, 1, 'active', ?, 0)`,
                [
                    userId,
                    amount,
                    netCapital,
                    entryFee,
                    formatDate(startDate),
                    formatDate(lockEndDate),
                    `Pool de Liquidez — Capital neto: $${netCapital.toLocaleString('es-CO')} (Comisión entrada: $${entryFee.toLocaleString('es-CO')}, 2%). Bloqueado hasta: ${formatDate(lockEndDate)}. Comisión retiro ganancias: 20%.`,
                ]
            );

            const investmentId = result.insertId;

            // Registrar transacción
            const refId = 'POOL-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

            await connection.execute(
                `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
                 VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
                [userId, investmentId, -amount, `Inversión Pool de Liquidez — Capital neto: $${netCapital.toLocaleString('es-CO')} (Comisión: $${entryFee.toLocaleString('es-CO')})`, refId]
            );

            // Audit log
            await auditLog({
                userId,
                action: 'create_pool_investment',
                entityType: 'investment',
                entityId: investmentId,
                details: { type: 'pool', amount, netCapital, entryFee, lockEndDate: formatDate(lockEndDate) },
                ipAddress: req.ip,
            });

            await connection.commit();

            return res.status(201).json({
                message: 'Inversión en Pool de Liquidez creada exitosamente',
                investment: {
                    id: investmentId,
                    type: 'pool',
                    amount,
                    netCapital,
                    entryFee,
                    startDate: formatDate(startDate),
                    lockEndDate: formatDate(lockEndDate),
                    durationMonths: 12,
                },
            });
        }

        // ============ CDTC (Lógica original) ============
        if (!productId) {
            return res.status(400).json({ error: 'productId es requerido para CDTC' });
        }

        // Configuración por plan
        const PLANS = {
            cdtc_3m: { durationMonths: 3, minRate: 2.0, maxRate: 3.0 },
            cdtc_6m: { durationMonths: 6, minRate: 2.0, maxRate: 4.0 },
            cdtc_12m: { durationMonths: 12, minRate: 3.0, maxRate: 4.0 },
        };
        const plan = PLANS[productId];
        if (!plan) {
            return res.status(400).json({ error: 'Producto no disponible. Usa: cdtc_3m, cdtc_6m o cdtc_12m' });
        }
        const { durationMonths: months, minRate, maxRate } = plan;
        if (amount < 100000 || !isFinite(amount)) {
            return res.status(400).json({ error: 'Monto mínimo de inversión: $100.000 COP' });
        }

        // Verificar máximo 3 CDTC activas por usuario
        const [activeCountRows] = await connection.execute(
            `SELECT COUNT(*) as c FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit') AND (LOWER(type) = 'cdtc' OR type IS NULL OR type NOT IN ('pool'))`,
            [userId]
        );
        if (activeCountRows[0].c >= 3) {
            return res.status(400).json({ error: 'Máximo 3 inversiones CDTC activas simultáneamente' });
        }

        // Verificar balance disponible
        const inflowPH2 = INFLOW_TYPES.map(() => '?').join(',');
        const outflowPH2 = OUTFLOW_TYPES.map(() => '?').join(',');
        const [inRows2] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (${inflowPH2})`,
            [userId, ...INFLOW_TYPES]
        );
        const [outRows2] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (${outflowPH2})`,
            [userId, ...OUTFLOW_TYPES]
        );
        const totalBalance = Math.max(0, parseFloat(inRows2[0].total) - parseFloat(outRows2[0].total));

        const [investedRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit')`,
            [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);

        const [pendingWithdrawals] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`,
            [userId]
        );
        const pendingWithdrawalAmount = parseFloat(pendingWithdrawals[0].total);

        const availableBalance = totalBalance - totalInvested - pendingWithdrawalAmount;

        if (amount > availableBalance || availableBalance < amount) {
            return res.status(400).json({
                error: `Saldo insuficiente. Disponible: $${Math.round(Math.max(0, availableBalance)).toLocaleString('es-CO')} COP`,
                available: Math.max(0, availableBalance),
            });
        }

        // Calcular fechas
        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + months);
        const lockEndDate = new Date(endDate);

        const formatDate = (d) => d.toISOString().slice(0, 10);

        // Crear la inversión en estado pending_deposit (12h para confirmar/cancelar)
        const depositDeadline = new Date();
        depositDeadline.setHours(depositDeadline.getHours() + 12);

        const [result] = await connection.execute(
            `INSERT INTO investments 
             (user_id, type, amount, annual_rate, duration_months, min_monthly_rate, max_monthly_rate, 
              start_date, end_date, lock_end_date, invested_from_balance, status, notes) 
             VALUES (?, 'CDTC', ?, 0, ?, ?, ?, ?, ?, ?, 1, 'pending_deposit', ?)`,
            [
                userId,
                amount,
                months,
                minRate,
                maxRate,
                formatDate(startDate),
                formatDate(endDate),
                formatDate(lockEndDate),
                `Inversión CDTC ${months}m — Período de depósito hasta: ${depositDeadline.toISOString().slice(0, 16).replace('T', ' ')}. Desbloqueo: ${formatDate(lockEndDate)}`,
            ]
        );

        const investmentId = result.insertId;

        // Registrar transacción
        const refId = 'INV-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
            [userId, investmentId, -amount, `Inversión CDTC a ${months} meses — Desbloqueo: ${formatDate(lockEndDate)}`, refId]
        );

        // Audit log
        await auditLog({
            userId,
            action: 'create_investment',
            entityType: 'investment',
            entityId: investmentId,
            details: { type: 'CDTC', amount, durationMonths: months, lockEndDate: formatDate(lockEndDate) },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.status(201).json({
            message: `Inversión CDTC a ${months} meses creada exitosamente`,
            investment: {
                id: investmentId,
                productId,
                amount,
                durationMonths: months,
                startDate: formatDate(startDate),
                lockEndDate: formatDate(lockEndDate),
                depositDeadline: depositDeadline.toISOString(),
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error creando inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/investments/balance-summary
// ═══════════════════════════════════════════════════════════════════════
exports.getBalanceSummary = async (req, res) => {
    try {
        const userId = req.user.id;

        const [balanceRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as amount FROM transactions WHERE user_id = ?`,
            [userId]
        );
        const totalBalance = balanceRows.length ? parseFloat(balanceRows[0].amount) : 0;

        const [investedRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit')`,
            [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);

        const [pendingWithdrawals] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`,
            [userId]
        );
        const pendingWithdrawalAmount = parseFloat(pendingWithdrawals[0].total);

        const [earningsRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount_earned), 0) as total FROM investment_returns WHERE user_id = ?`,
            [userId]
        );
        const totalEarnings = parseFloat(earningsRows[0].total);

        const availableBalance = totalBalance - totalInvested - pendingWithdrawalAmount;

        res.json({
            totalBalance,
            totalInvested,
            availableBalance: Math.max(0, availableBalance),
            totalEarnings,
            pendingWithdrawals: pendingWithdrawalAmount,
        });
    } catch (error) {
        console.error('Error balance summary:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/investments/global-stats
// ═══════════════════════════════════════════════════════════════════════
exports.getGlobalStats = async (req, res) => {
    try {
        const [lockedRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count 
             FROM investments WHERE status IN ('active', 'pending_deposit')`
        );
        const totalLocked = parseFloat(lockedRows[0].total);
        const totalActiveInvestments = parseInt(lockedRows[0].count);

        const [usersRows] = await pool.execute(
            `SELECT COUNT(DISTINCT user_id) as count FROM investments WHERE status IN ('active', 'pending_deposit')`
        );
        const totalInvestors = parseInt(usersRows[0].count);

        const [returnsRows] = await pool.execute(
            `SELECT AVG(rate_applied) as avg FROM investment_returns WHERE status = 'paid' AND rate_applied > 0`
        );
        const avgAPY = returnsRows[0].avg ? parseFloat(returnsRows[0].avg) : 0;

        res.json({
            totalLockedCapital: totalLocked,
            totalActiveInvestments,
            totalInvestors,
            avgMonthlyAPY: avgAPY,
        });
    } catch (error) {
        console.error('Error global stats:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/investments/my
// ═══════════════════════════════════════════════════════════════════════
exports.getMyInvestments = async (req, res) => {
    try {
        const userId = req.user.id;

        const [investments] = await pool.execute(
            `SELECT id, type, amount, net_capital, entry_fee, withdrawable_earnings, annual_rate, duration_months, 
                    min_monthly_rate, max_monthly_rate, start_date, end_date, lock_end_date, status, notes, created_at
             FROM investments WHERE user_id = ? ORDER BY created_at DESC`,
            [userId]
        );

        const results = await Promise.all(
            investments.map(async (inv) => {
                const [returns] = await pool.execute(
                    `SELECT period_month, rate_applied, amount_earned, status 
                     FROM investment_returns WHERE investment_id = ? ORDER BY period_month ASC`,
                    [inv.id]
                );

                const now = new Date();
                const depositDeadlineMatch = inv.notes?.match(/Período de depósito hasta: ([\d-: ]+)/);
                const depositDeadline = depositDeadlineMatch ? new Date(depositDeadlineMatch[1].replace(' ', 'T')) : null;

                return {
                    id: inv.id,
                    type: inv.type || 'CDTC',
                    amount: parseFloat(inv.amount),
                    netCapital: inv.net_capital ? parseFloat(inv.net_capital) : null,
                    entryFee: inv.entry_fee ? parseFloat(inv.entry_fee) : null,
                    withdrawableEarnings: inv.withdrawable_earnings ? parseFloat(inv.withdrawable_earnings) : null,
                    durationMonths: inv.duration_months,
                    minMonthlyRate: inv.min_monthly_rate ? parseFloat(inv.min_monthly_rate) : null,
                    maxMonthlyRate: inv.max_monthly_rate ? parseFloat(inv.max_monthly_rate) : null,
                    startDate: inv.start_date,
                    endDate: inv.end_date,
                    lockEndDate: inv.lock_end_date,
                    status: inv.status,
                    notes: inv.notes,
                    createdAt: inv.created_at,
                    totalEarned: returns.reduce((sum, r) => sum + parseFloat(r.amount_earned), 0),
                    canCancel: inv.status === 'pending_deposit' && depositDeadline && now < depositDeadline,
                    depositDeadline: inv.status === 'pending_deposit' && depositDeadline ? depositDeadline.toISOString() : null,
                    returns: returns.map((r) => ({
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
        console.error('Error obteniendo inversiones:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /api/investments/:id
// ═══════════════════════════════════════════════════════════════════════
exports.getInvestmentDetail = async (req, res) => {
    try {
        const userId = req.user.id;
        const investmentId = req.params.id;

        const [rows] = await pool.execute(
            `SELECT * FROM investments WHERE id = ? AND user_id = ?`,
            [investmentId, userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'Inversión no encontrada' });

        const inv = rows[0];
        const now = new Date();
        const end = new Date(inv.lock_end_date || inv.end_date);
        const isMatured = now >= end;

        const [returns] = await pool.execute(
            `SELECT period_month, rate_applied, amount_earned, status, notes 
             FROM investment_returns WHERE investment_id = ? ORDER BY period_month ASC`,
            [investmentId]
        );

        const [transactions] = await pool.execute(
            `SELECT type, amount, description, ref_id, created_at 
             FROM transactions WHERE investment_id = ? ORDER BY created_at DESC`,
            [investmentId]
        );

        res.json({
            investment: {
                id: inv.id,
                type: inv.type || 'CDTC',
                amount: parseFloat(inv.amount),
                netCapital: inv.net_capital ? parseFloat(inv.net_capital) : null,
                entryFee: inv.entry_fee ? parseFloat(inv.entry_fee) : null,
                withdrawableEarnings: inv.withdrawable_earnings ? parseFloat(inv.withdrawable_earnings) : null,
                durationMonths: inv.duration_months,
                minMonthlyRate: inv.min_monthly_rate ? parseFloat(inv.min_monthly_rate) : null,
                maxMonthlyRate: inv.max_monthly_rate ? parseFloat(inv.max_monthly_rate) : null,
                startDate: inv.start_date,
                endDate: inv.end_date,
                lockEndDate: inv.lock_end_date,
                status: inv.status,
                notes: inv.notes,
                createdAt: inv.created_at,
                isMatured,
            },
            returns: returns.map((r) => ({
                month: r.period_month,
                rate: parseFloat(r.rate_applied),
                earned: parseFloat(r.amount_earned),
                status: r.status,
                notes: r.notes,
            })),
            transactions: transactions.map((t) => ({
                type: t.type,
                amount: parseFloat(t.amount),
                description: t.description,
                refId: t.ref_id,
                createdAt: t.created_at,
            })),
        });
    } catch (error) {
        console.error('Error obteniendo detalle de inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/investments/:id/add-capital
// ═══════════════════════════════════════════════════════════════════════
exports.addCapitalToInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const investmentId = req.params.id;
        const addAmount = parseFloat(req.body.amount);

        if (!addAmount || addAmount <= 0) {
            return res.status(400).json({ error: 'Monto inválido' });
        }

        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND user_id = ?`,
            [investmentId, userId]
        );
        if (!invRows.length) {
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const inv = invRows[0];
        if (inv.status !== 'active') {
            return res.status(400).json({ error: 'Solo se puede agregar capital a inversiones activas' });
        }

        // Verificar balance disponible
        const [balanceRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as amount FROM transactions WHERE user_id = ?`,
            [userId]
        );
        const totalBalance = parseFloat(balanceRows[0].amount);

        const [investedRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit')`,
            [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);

        const [pendingWithdrawals] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`,
            [userId]
        );
        const pendingWithdrawalAmount = parseFloat(pendingWithdrawals[0].total);

        const availableBalance = totalBalance - totalInvested - pendingWithdrawalAmount;

        if (addAmount > availableBalance) {
            return res.status(400).json({
                error: `Saldo insuficiente. Disponible: $${Math.round(Math.max(0, availableBalance)).toLocaleString('es-CO')} COP`,
            });
        }

        // Actualizar monto de la inversión
        const newAmount = parseFloat(inv.amount) + addAmount;
        await connection.execute(
            `UPDATE investments SET amount = ? WHERE id = ?`,
            [newAmount, investmentId]
        );

        // Registrar transacción
        const refId = 'ADD-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
            [userId, investmentId, -addAmount, `Adición de capital a inversión #${investmentId}`, refId]
        );

        await auditLog({
            userId,
            action: 'add_capital_to_investment',
            entityType: 'investment',
            entityId: parseInt(investmentId),
            details: { addedAmount: addAmount, newTotalAmount: newAmount },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.json({
            message: 'Capital agregado exitosamente',
            investment: {
                id: parseInt(investmentId),
                previousAmount: parseFloat(inv.amount),
                addedAmount: addAmount,
                newAmount,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error agregando capital:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/investments/:id/cancel
// ═══════════════════════════════════════════════════════════════════════
exports.cancelInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const investmentId = req.params.id;

        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND user_id = ?`,
            [investmentId, userId]
        );
        if (!invRows.length) {
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const inv = invRows[0];
        if (inv.status !== 'pending_deposit') {
            return res.status(400).json({ error: 'Solo se pueden cancelar inversiones en período de depósito' });
        }

        const depositDeadlineMatch = inv.notes?.match(/Período de depósito hasta: ([\d-: ]+)/);
        const depositDeadline = depositDeadlineMatch ? new Date(depositDeadlineMatch[1].replace(' ', 'T')) : null;

        if (!depositDeadline || new Date() > depositDeadline) {
            return res.status(400).json({ error: 'El período de cancelación ha expirado' });
        }

        await connection.execute(
            `UPDATE investments SET status = 'cancelled' WHERE id = ?`,
            [investmentId]
        );

        const refId = 'CAN-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment_cancellation', ?, ?, ?, NOW())`,
            [userId, investmentId, parseFloat(inv.amount), `Cancelación inversión #${investmentId}`, refId]
        );

        await auditLog({
            userId,
            action: 'cancel_investment',
            entityType: 'investment',
            entityId: parseInt(investmentId),
            details: { cancelledAmount: parseFloat(inv.amount) },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.json({
            message: 'Inversión cancelada. El capital ha sido devuelto a tu saldo disponible.',
            investment: { id: parseInt(investmentId), cancelledAmount: parseFloat(inv.amount) },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error cancelando inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/investments/:id/confirm
// ═══════════════════════════════════════════════════════════════════════
exports.confirmInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const investmentId = req.params.id;

        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND user_id = ?`,
            [investmentId, userId]
        );
        if (!invRows.length) {
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const inv = invRows[0];
        if (inv.status !== 'pending_deposit') {
            return res.status(400).json({ error: 'Solo se pueden confirmar inversiones pendientes' });
        }

        await connection.execute(
            `UPDATE investments SET status = 'active' WHERE id = ?`,
            [investmentId]
        );

        await auditLog({
            userId,
            action: 'confirm_investment',
            entityType: 'investment',
            entityId: parseInt(investmentId),
            details: { amount: parseFloat(inv.amount) },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.json({
            message: 'Inversión confirmada y activada exitosamente',
            investment: { id: parseInt(investmentId), status: 'active' },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error confirmando inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/investments/:id/withdraw
// ═══════════════════════════════════════════════════════════════════════
exports.withdrawInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const investmentId = req.params.id;

        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND user_id = ?`,
            [investmentId, userId]
        );
        if (!invRows.length) {
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const inv = invRows[0];
        if (inv.status !== 'active') {
            return res.status(400).json({ error: 'Solo se pueden retirar inversiones activas' });
        }

        const now = new Date();
        const lockEnd = new Date(inv.lock_end_date || inv.end_date);

        if (now < lockEnd) {
            const daysLeft = Math.ceil((lockEnd - now) / (1000 * 60 * 60 * 24));
            return res.status(400).json({
                error: `La inversión aún está bloqueada. Faltan ${daysLeft} días para el desbloqueo.`,
                daysRemaining: daysLeft,
                lockEndDate: lockEnd.toISOString().slice(0, 10),
            });
        }

        const capitalAmount = parseFloat(inv.amount);

        await connection.execute(
            `UPDATE investments SET status = 'completed' WHERE id = ?`,
            [investmentId]
        );

        const refId = 'WDR-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment_withdrawal', ?, ?, ?, NOW())`,
            [userId, investmentId, capitalAmount, `Retiro inversión ${inv.type || 'CDTC'} #${investmentId} — Capital liberado`, refId]
        );

        await auditLog({
            userId,
            action: 'withdraw_investment',
            entityType: 'investment',
            entityId: parseInt(investmentId),
            details: { capitalReturned: capitalAmount },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.json({
            message: 'Inversión retirada exitosamente. El capital ha vuelto a tu saldo disponible.',
            investment: {
                id: parseInt(investmentId),
                capitalReturned: capitalAmount,
                refId,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error retirando inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};
// ═══════════════════════════════════════════════════════════════════════
// GET /api/investments/pool-stats
// Estadísticas del Pool de Liquidez para el dashboard
// ═══════════════════════════════════════════════════════════════════════
exports.getPoolStats = async (req, res) => {
    try {
        // APY real calculado desde rendimientos históricos pagados del pool
        const [returnsRows] = await pool.execute(
            `SELECT AVG(ir.rate_applied) as avg_rate, COUNT(DISTINCT ir.period_month) as months
             FROM investment_returns ir
             JOIN investments i ON ir.investment_id = i.id
             WHERE i.type = 'pool' AND ir.status = 'paid' AND ir.rate_applied > 0`
        );

        const avgMonthly = returnsRows[0].avg_rate ? parseFloat(returnsRows[0].avg_rate) : 2.0;
        const monthsTracked = returnsRows[0].months ? parseInt(returnsRows[0].months) : 0;
        // APY anual compuesto
        const annualAPY = (Math.pow(1 + avgMonthly / 100, 12) - 1) * 100;

        // Capital total activo en el pool
        const [capitalRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
             FROM investments WHERE type = 'pool' AND status = 'active'`
        );

        res.json({
            monthlyAPY:    parseFloat(avgMonthly.toFixed(4)),
            annualAPY:     parseFloat(annualAPY.toFixed(2)),
            monthsTracked,
            totalCapital:  parseFloat(capitalRows[0].total),
            activeCount:   parseInt(capitalRows[0].count),
        });
    } catch (error) {
        console.error('Error pool stats:', error);
        // Fallback con valores por defecto — no romper el dashboard
        res.json({ monthlyAPY: 2.0, annualAPY: 26.82, monthsTracked: 0, totalCapital: 0, activeCount: 0 });
    }
};