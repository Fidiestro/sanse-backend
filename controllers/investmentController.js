const { pool } = require('../config/database');
const { auditLog } = require('../utils/helpers');
const { INFLOW_TYPES, OUTFLOW_TYPES, recalculateAndSaveBalance } = require('../utils/balanceHelper');

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
            // IMPORTANTE: investments.amount conserva el BRUTO ($1M) para mostrar correctamente en UI,
            // pero net_capital ($980k) es el monto que realmente entra al pool y se devuelve al vencer.
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

            // ── 2 TRANSACCIONES SEPARADAS para que el cliente vea el desglose ──
            // Suma: -netCapital + -entryFee = -amount (el balance baja igual)
            const baseRef = Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            const invRefId = 'POOL-' + baseRef;
            const feeRefId = 'FEE-' + baseRef;

            // 1) Capital neto que entra al pool
            await connection.execute(
                `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
                 VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
                [userId, investmentId, -netCapital,
                 `Inversión Pool #${investmentId} — Capital neto al pool`, invRefId]
            );

            // 2) Comisión de entrada 2% (transacción separada para que se vea explícita)
            await connection.execute(
                `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
                 VALUES (?, ?, 'fee', ?, ?, ?, NOW())`,
                [userId, investmentId, entryFee,
                 `Comisión de entrada Pool #${investmentId} — 2% del capital ($${amount.toLocaleString('es-CO')})`, feeRefId]
            );

            // Recalcular balance (refleja el descuento total: netCapital + fee = amount)
            await recalculateAndSaveBalance(connection, userId);

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
        const { INFLOW_TYPES, OUTFLOW_TYPES } = require('../utils/balanceHelper');

        // Entradas (depósitos, pagos, intereses, ganancias, retornos de inversión, etc.)
        const inflowPH = INFLOW_TYPES.map(() => '?').join(',');
        const [inRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (${inflowPH})`,
            [userId, ...INFLOW_TYPES]
        );

        // Salidas (retiros)
        const outflowPH = OUTFLOW_TYPES.map(() => '?').join(',');
        const [outRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN (${outflowPH})`,
            [userId, ...OUTFLOW_TYPES]
        );

        const totalBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));

        // Capital actualmente invertido
        const [investedRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit')`,
            [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);

        // Retiros pendientes
        const [pendingWithdrawals] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`,
            [userId]
        );
        const pendingWithdrawalAmount = parseFloat(pendingWithdrawals[0].total);

        // Ganancias totales pagadas
        const [earningsRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('profit','interest','investment_return')`,
            [userId]
        );
        const totalEarnings = parseFloat(earningsRows[0].total);

        const availableBalance = Math.max(0, totalBalance - totalInvested - pendingWithdrawalAmount);

        res.json({
            totalBalance,
            totalInvested,
            availableBalance,
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

        // ── AUTO-CANCEL: marca como 'cancelled' las inversiones que pasaron
        // su deadline de confirmación (12h). Esto evita cron jobs externos.
        // Se hace al leer porque la app consulta esta ruta frecuentemente.
        try {
            const [stale] = await pool.execute(
                `SELECT id, amount, notes FROM investments
                 WHERE user_id = ? AND status = 'pending_deposit'`,
                [userId]
            );
            let cancelledAny = false;
            for (const inv of stale) {
                const m = inv.notes ? inv.notes.match(/Período de depósito hasta: ([\d-: ]+)/) : null;
                if (!m) continue;
                const deadline = new Date(m[1].replace(' ', 'T'));
                if (isNaN(deadline) || new Date() <= deadline) continue;
                // Vencida → cancelar y devolver capital con transacción
                await pool.execute(`UPDATE investments SET status = 'cancelled' WHERE id = ?`, [inv.id]);
                const refId = 'AUTO-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
                // FIX: usar tipo válido del balanceHelper ('investment_withdrawal' está en INFLOW_TYPES)
                await pool.execute(
                    `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at)
                     VALUES (?, ?, 'investment_withdrawal', ?, ?, ?, NOW())`,
                    [userId, inv.id, parseFloat(inv.amount), `Cancelación automática inversión #${inv.id} — Depósito no confirmado en 12h`, refId]
                );
                cancelledAny = true;
            }
            if (cancelledAny) {
                await recalculateAndSaveBalance(pool, userId);
            }
        } catch (e) {
            console.warn('[getMyInvestments auto-cancel]', e.message);
        }

        const [investments] = await pool.execute(
            `SELECT id, type, amount, net_capital, entry_fee, withdrawable_earnings, annual_rate, duration_months, 
                    min_monthly_rate, max_monthly_rate, start_date, end_date, lock_end_date, status, notes, created_at
             FROM investments WHERE user_id = ? ORDER BY created_at DESC`,
            [userId]
        );

        const results = await Promise.all(
            investments.map(async (inv) => {
                const [returns] = await pool.execute(
                    `SELECT period_month, rate_applied, amount_earned, status, created_at
                     FROM investment_returns WHERE investment_id = ? ORDER BY period_month ASC, created_at ASC`,
                    [inv.id]
                );

                const now = new Date();
                const depositDeadlineMatch = inv.notes?.match(/Período de depósito hasta: ([\d-: ]+)/);
                const depositDeadline = depositDeadlineMatch ? new Date(depositDeadlineMatch[1].replace(' ', 'T')) : null;

                // ─── LP COP: acumulado real pendiente de reclamo ───
                // El rendimiento se devenga el día 1 de cada mes (2% mensual) y se guarda
                // en investment_returns con status='accrued'. Aquí solo SUMAMOS lo pendiente.
                // (Ya no se calcula "en vivo por segundos" — eso causaba sobrepagos.)
                const invType = (inv.type || '').toLowerCase();
                const isPool  = invType === 'pool';
                const isCdtcActive = !isPool && inv.status === 'active';

                let accruedPending = 0;
                if (isCdtcActive) {
                    const [accRows] = await pool.execute(
                        `SELECT COALESCE(SUM(amount_earned), 0) as total
                         FROM investment_returns
                         WHERE investment_id = ? AND status = 'accrued'`,
                        [inv.id]
                    );
                    accruedPending = parseFloat(accRows[0].total) || 0;
                }

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
                    // LP COP: acumulado real pendiente de reclamo (devengado el día 1)
                    accruedPending,
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

        // LP COP: acumulado real pendiente de reclamo (devengado el día 1, no "en vivo").
        const invType = (inv.type || '').toLowerCase();
        const isPool  = invType === 'pool';
        const isCdtcActive = !isPool && inv.status === 'active';
        let accruedPending = 0;

        if (isCdtcActive) {
            const [accRows] = await pool.execute(
                `SELECT COALESCE(SUM(amount_earned), 0) as total
                 FROM investment_returns
                 WHERE investment_id = ? AND status = 'accrued'`,
                [investmentId]
            );
            accruedPending = parseFloat(accRows[0].total) || 0;
        }

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
                // LP COP: acumulado real pendiente de reclamo
                accruedPending,
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
            await connection.rollback();
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const inv = invRows[0];
        if (inv.status !== 'pending_deposit') {
            await connection.rollback();
            return res.status(400).json({ error: 'Solo se pueden cancelar inversiones en período de depósito' });
        }

        // FIX: la verificación de deadline solo aplica si HAY deadline en las notas.
        // Si no lo encuentra, permitimos cancelar igual (no bloquear al usuario).
        const depositDeadlineMatch = inv.notes?.match(/Período de depósito hasta: ([\d-: ]+)/);
        if (depositDeadlineMatch) {
            const depositDeadline = new Date(depositDeadlineMatch[1].replace(' ', 'T'));
            if (!isNaN(depositDeadline) && new Date() > depositDeadline) {
                // Deadline pasada — igual permitimos cancelar (auto-cancel también lo haría)
                // pero avisamos en notes
            }
        }

        await connection.execute(
            `UPDATE investments SET status = 'cancelled' WHERE id = ?`,
            [investmentId]
        );

        // FIX: el tipo correcto es 'investment_withdrawal' (está en INFLOW_TYPES del balanceHelper).
        // 'investment_cancellation' NO existe → el dinero quedaba fantasma sin afectar balance.
        // Como al crear la inversión se hizo type='investment' con monto negativo (out),
        // ahora hacemos 'investment_withdrawal' con monto positivo (in) → balance neutro.
        const capitalAmount = parseFloat(inv.amount);
        const refId = 'CAN-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment_withdrawal', ?, ?, ?, NOW())`,
            [userId, investmentId, capitalAmount, `Cancelación inversión #${investmentId} — Capital devuelto`, refId]
        );

        // FIX: recalcular balance del usuario para que el capital cancelado vuelva al saldo disponible.
        await recalculateAndSaveBalance(connection, userId);

        await auditLog({
            userId,
            action: 'cancel_investment',
            entityType: 'investment',
            entityId: parseInt(investmentId),
            details: { cancelledAmount: capitalAmount },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.json({
            message: 'Inversión cancelada. El capital ha sido devuelto a tu saldo disponible.',
            investment: { id: parseInt(investmentId), cancelledAmount: capitalAmount, refId },
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

        // FIX BUG #4: atomic UPDATE para prevenir race condition de doble-click.
        // En vez de SELECT → check status → UPDATE (3 pasos no-atómicos), hacemos
        // el UPDATE con WHERE status='pending_deposit'. Si otro request ya cambió
        // el status, affectedRows = 0 y abortamos.
        const [updResult] = await connection.execute(
            `UPDATE investments
             SET status = 'active', start_date = NOW()
             WHERE id = ? AND user_id = ? AND status = 'pending_deposit'`,
            [investmentId, userId]
        );

        if (updResult.affectedRows === 0) {
            await connection.rollback();
            // Verificar si existe pero no es pending
            const [check] = await connection.execute(
                `SELECT status FROM investments WHERE id = ? AND user_id = ?`,
                [investmentId, userId]
            );
            if (!check.length) {
                return res.status(404).json({ error: 'Inversión no encontrada' });
            }
            return res.status(400).json({
                error: `Esta inversión ya fue procesada anteriormente (estado actual: ${check[0].status})`
            });
        }

        // Recuperar la inversión actualizada para el audit log
        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ?`, [investmentId]
        );
        const inv = invRows[0];

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
            await connection.rollback();
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const inv = invRows[0];
        if (inv.status !== 'active') {
            await connection.rollback();
            return res.status(400).json({ error: 'Solo se pueden retirar inversiones activas' });
        }

        const now = new Date();
        const lockEnd = new Date(inv.lock_end_date || inv.end_date);

        if (now < lockEnd) {
            await connection.rollback();
            const daysLeft = Math.ceil((lockEnd - now) / (1000 * 60 * 60 * 24));
            return res.status(400).json({
                error: `La inversión aún está bloqueada. Faltan ${daysLeft} días para el desbloqueo.`,
                daysRemaining: daysLeft,
                lockEndDate: lockEnd.toISOString().slice(0, 10),
            });
        }

        // FIX: si hay ganancias pendientes, forzar claim primero para que no se pierdan
        // al marcar la inversión como completed.
        //   - Pool: lee withdrawable_earnings
        //   - LP COP: lee el acumulado real (investment_returns con status='accrued')
        const invType = (inv.type || '').toLowerCase();
        const isPool = invType === 'pool';
        let pendingEarnings = 0;
        if (isPool) {
            pendingEarnings = parseFloat(inv.withdrawable_earnings) || 0;
        } else {
            // LP COP: rendimiento devengado el día 1, pendiente de reclamo.
            const [accRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount_earned), 0) as total
                 FROM investment_returns
                 WHERE investment_id = ? AND status = 'accrued'`,
                [investmentId]
            );
            pendingEarnings = parseFloat(accRows[0].total) || 0;
        }

        if (pendingEarnings >= 10) {
            await connection.rollback();
            return res.status(400).json({
                error: `Tienes $${pendingEarnings.toLocaleString('es-CO')} en ganancias pendientes. Retíralas primero (botón "Reclamar Ganancias") antes de retirar el capital.`,
                pendingEarnings,
            });
        }

        // FIX: Pool devuelve net_capital (descontó 2% al entrar). CDTC devuelve amount completo.
        const capitalAmount = isPool
            ? (parseFloat(inv.net_capital) || parseFloat(inv.amount))
            : parseFloat(inv.amount);

        await connection.execute(
            `UPDATE investments SET status = 'completed' WHERE id = ?`,
            [investmentId]
        );

        const refId = 'WDR-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        const desc = isPool
            ? `Retiro Pool #${investmentId} — Capital neto liberado ($${capitalAmount.toLocaleString('es-CO')}). Comisión de entrada 2% no reembolsable.`
            : `Retiro inversión ${inv.type || 'CDTC'} #${investmentId} — Capital liberado`;

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment_withdrawal', ?, ?, ?, NOW())`,
            [userId, investmentId, capitalAmount, desc, refId]
        );

        // FIX: recalcular balance para que el capital liberado quede reflejado.
        await recalculateAndSaveBalance(connection, userId);

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
// ══════════════════════════════════════════════════════════════
// POST /api/investments/:id/withdraw-earnings
// Retirar ganancias acumuladas (Pool o CDTC).
// Descuentos sobre el bruto:
//   - Pool: 20% Sanse + 5% referido (si aplica)
//   - CDTC: solo 5% referido (si aplica), sin comisión Sanse
// El cliente recibe: gross - sanse - referral
// ══════════════════════════════════════════════════════════════
exports.withdrawPoolEarnings = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { id } = req.params;
        const userId = req.user.id;

        const [rows] = await connection.execute(
            `SELECT * FROM investments
             WHERE id = ? AND user_id = ? AND status = 'active'`,
            [id, userId]
        );

        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Inversión no encontrada' });
        }

        const inv = rows[0];
        const invType = (inv.type || '').toLowerCase();
        const isPool  = invType === 'pool';
        const label   = isPool ? 'Pool' : 'CDTC';

        // Resolve referrer ONCE (reused for both gross calculation and commission)
        const [refRows] = await connection.execute(
            'SELECT referred_by FROM users WHERE id = ?', [userId]
        );
        const referrerId = (refRows.length && refRows[0].referred_by) ? refRows[0].referred_by : null;
        const hasReferrer = !!referrerId;

        // ════════════════════════════════════════════════════════════════
        // Este endpoint es SOLO para el Pool de Liquidez.
        // LP COP (CDTC) usa /api/investments/lp/claim, que reclama el rendimiento
        // ya devengado (status='accrued') en investment_returns.
        // Antes este branch calculaba CDTC "en vivo por segundos", lo que causó
        // un sobrepago grave. Por eso ahora rechaza cualquier inversión que no sea Pool.
        // ════════════════════════════════════════════════════════════════
        if (!isPool) {
            await connection.rollback();
            return res.status(400).json({
                error: 'Para LP COP usa el reclamo de rendimientos mensuales (/lp/claim).',
                redirect: '/investments/lp/claim',
            });
        }

        let grossEarnings = parseFloat(inv.withdrawable_earnings) || 0;

        if (grossEarnings <= 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'No hay ganancias disponibles para retirar' });
        }

        // ── Cálculos de comisiones (Pool: 20% Sanse + 5% referido) ──
        const sanseCommission = isPool ? Math.round(grossEarnings * 0.20) : 0;
        const referralCommission = hasReferrer ? Math.round(grossEarnings * 0.05) : 0;
        const netAmount = grossEarnings - sanseCommission - referralCommission;

        // ── 1. Reset de withdrawable_earnings (solo Pool — CDTC no lo usa) ──
        if (isPool) {
            await connection.execute(
                'UPDATE investments SET withdrawable_earnings = 0 WHERE id = ?',
                [id]
            );
        }

        // ── 2. Crear transacción del retiro neto al usuario ──
        const refId = 'PWR-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        // Armado dinámico de la descripción según comisiones aplicadas
        const descParts = [`Retiro ganancias ${label} #${id} — Bruto: $${grossEarnings.toLocaleString('es-CO')}`];
        if (sanseCommission > 0) {
            descParts.push(`Comisión Sanse 20%: -$${sanseCommission.toLocaleString('es-CO')}`);
        }
        if (referralCommission > 0) {
            descParts.push(`Comisión referido 5%: -$${referralCommission.toLocaleString('es-CO')}`);
        }
        const description = descParts.join(' · ');

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at)
             VALUES (?, ?, 'investment_return', ?, ?, ?, NOW())`,
            [userId, id, netAmount, description, refId]
        );

        // ── 3. Registro contable en pool_withdrawals (solo Pool) ──
        if (isPool) {
            try {
                await connection.execute(
                    `INSERT INTO pool_withdrawals
                        (investment_id, user_id, gross_amount, commission, net_amount, withdrawal_date)
                     VALUES (?, ?, ?, ?, ?, NOW())`,
                    [id, userId, grossEarnings, sanseCommission, netAmount]
                );
            } catch (e) {
                try {
                    await connection.execute(
                        `INSERT INTO pool_withdrawals (investment_id, user_id, gross_amount, commission, net_amount)
                         VALUES (?, ?, ?, ?, ?)`,
                        [id, userId, grossEarnings, sanseCommission, netAmount]
                    );
                } catch (_) {
                    console.warn('[withdrawPoolEarnings] pool_withdrawals insert falló — revisar schema');
                }
            }
        }

        // ── 4. Pagar comisión al referidor (si aplica) ──
        let referralRefId = null;
        if (referrerId && referralCommission >= 100) {
            referralRefId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            const refSourceType = isPool ? 'pool_withdrawal' : 'cdtc_withdrawal';

            try {
                await connection.execute(
                    `INSERT INTO referral_commissions
                        (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id)
                     VALUES (?, ?, ?, ?, ?, 0.05, ?, 'paid', ?)`,
                    [referrerId, userId, refSourceType, id, grossEarnings, referralCommission, referralRefId]
                );
            } catch (e) {
                console.error('Error registrando comisión referido:', e.message);
            }

            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
                 VALUES (?, 'profit', ?, ?, ?, NOW())`,
                [referrerId, referralCommission,
                 `Comisión referido — 5% de retiro ${label} (Bruto: $${grossEarnings.toLocaleString('es-CO')})`,
                 referralRefId]
            );

            await recalculateAndSaveBalance(connection, referrerId);
        }

        // ── 5. Recalcular balance del usuario ──
        await recalculateAndSaveBalance(connection, userId);

        await connection.commit();

        // ── 6. Telegram (best-effort, fuera de transacción) ──
        try {
            const { sendTelegram } = require('../utils/telegram');
            const [userRows] = await pool.execute('SELECT full_name, email FROM users WHERE id = ?', [userId]);
            const userName = userRows[0]?.full_name || userRows[0]?.email || `ID ${userId}`;
            await sendTelegram(
                `💰 <b>Retiro Ganancias ${label}</b>\n\n` +
                `👤 <b>Usuario:</b> ${userName}\n` +
                `🆔 <b>Inversión:</b> #${id}\n` +
                `💵 <b>Bruto:</b> $${grossEarnings.toLocaleString('es-CO')} COP\n` +
                (sanseCommission > 0
                    ? `📉 <b>Comisión Sanse 20%:</b> -$${sanseCommission.toLocaleString('es-CO')} COP\n`
                    : '') +
                (referralCommission > 0
                    ? `🤝 <b>Comisión Referido 5%:</b> -$${referralCommission.toLocaleString('es-CO')} COP\n`
                    : '') +
                `✅ <b>Neto recibido:</b> $${netAmount.toLocaleString('es-CO')} COP`
            );
        } catch (_) { /* ignore telegram errors */ }

        return res.json({
            success: true,
            type: invType,
            grossEarnings,
            sanseCommission,
            commission: sanseCommission,    // alias retro-compat con frontend antiguo
            referralCommission,
            netAmount,
            referral: referrerId && referralCommission > 0
                ? { referrerId, commission: referralCommission, refId: referralRefId }
                : null,
        });

    } catch (e) {
        await connection.rollback();
        console.error('[withdrawPoolEarnings]', e);
        return res.status(500).json({ error: 'Error al retirar ganancias' });
    } finally {
        connection.release();
    }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /api/admin/investments/create — ADMIN crea inversión a un usuario
// Body: { userId, type: 'cdtc'|'pool', amount, durationMonths: 6|12, startDate?, notes? }
//
// Replica la lógica de createUserInvestment pero:
//   - El admin la ejecuta sobre el userId del body (no req.user.id)
//   - Permite startDate personalizado (registrar inversiones que empezaron antes)
//   - SÍ descuenta del saldo del usuario y valida saldo disponible
//   - Pool aplica comisión de entrada 2% (igual que el usuario)
//   - Respeta separación LP COP (CDTC, investment_returns) vs Pool (withdrawable_earnings)
// ═══════════════════════════════════════════════════════════════════════
exports.adminCreateInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const { userId, type, durationMonths, notes } = req.body;
        const amount = parseFloat(req.body.amount);
        const rawStart = (req.body.startDate || '').toString().trim();

        // ── Validaciones base ──
        if (!userId) return res.status(400).json({ error: 'userId es requerido' });
        if (!['cdtc', 'pool'].includes(type)) {
            return res.status(400).json({ error: "type inválido. Usa: 'cdtc' o 'pool'" });
        }
        if (!amount || isNaN(amount) || amount < 50000) {
            return res.status(400).json({ error: 'Monto mínimo $50.000 COP' });
        }
        const months = parseInt(durationMonths);
        if (![3, 6, 12].includes(months)) {
            return res.status(400).json({ error: 'Bloqueo inválido. Usa 3, 6 o 12 meses' });
        }

        // ── Verificar que el usuario exista ──
        const [userRows] = await connection.execute('SELECT id, full_name FROM users WHERE id = ?', [userId]);
        if (!userRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // ── Fecha de inicio (personalizable) y de bloqueo ──
        const formatDate = (d) => d.toISOString().slice(0, 10);
        let startDate;
        if (rawStart) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
                await connection.rollback();
                return res.status(400).json({ error: 'Fecha de inicio inválida (YYYY-MM-DD)' });
            }
            startDate = new Date(rawStart + 'T00:00:00');
            if (isNaN(startDate.getTime())) {
                await connection.rollback();
                return res.status(400).json({ error: 'Fecha de inicio inválida' });
            }
        } else {
            startDate = new Date();
        }
        const lockEndDate = new Date(startDate);
        lockEndDate.setMonth(lockEndDate.getMonth() + months);

        // ── Verificar saldo disponible del usuario (igual que createUserInvestment) ──
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

        const [pendingWr] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`,
            [userId]
        );
        const pendingWithdrawalAmount = parseFloat(pendingWr[0].total);

        const availableBalance = Math.max(0, totalBalance - totalInvested - pendingWithdrawalAmount);
        if (amount > availableBalance) {
            await connection.rollback();
            return res.status(400).json({
                error: `Saldo insuficiente del usuario. Disponible: $${Math.round(availableBalance).toLocaleString('es-CO')} COP`,
                available: availableBalance,
            });
        }

        let investmentId;

        // ════════════ FONDO DGP (POOL) ════════════
        if (type === 'pool') {
            const entryFee = Math.round(amount * 0.02);
            const netCapital = amount - entryFee;

            const [result] = await connection.execute(
                `INSERT INTO investments 
                 (user_id, type, amount, net_capital, entry_fee, duration_months, 
                  start_date, lock_end_date, invested_from_balance, status, notes, withdrawable_earnings) 
                 VALUES (?, 'pool', ?, ?, ?, ?, ?, ?, 1, 'active', ?, 0)`,
                [
                    userId, amount, netCapital, entryFee, months,
                    formatDate(startDate), formatDate(lockEndDate),
                    `[ADMIN] Fondo DGP — Capital neto: $${netCapital.toLocaleString('es-CO')} (Comisión entrada 2%: $${entryFee.toLocaleString('es-CO')}). Bloqueo: ${formatDate(lockEndDate)}.${notes ? ' | ' + notes : ''}`,
                ]
            );
            investmentId = result.insertId;

            const baseRef = Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            // 1) Capital neto al pool
            await connection.execute(
                `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
                 VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
                [userId, investmentId, -netCapital, `Inversión Pool #${investmentId} — Capital neto al pool (admin)`, 'POOL-' + baseRef]
            );
            // 2) Comisión de entrada 2%
            await connection.execute(
                `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
                 VALUES (?, ?, 'fee', ?, ?, ?, NOW())`,
                [userId, investmentId, entryFee, `Comisión de entrada Pool #${investmentId} — 2% de $${amount.toLocaleString('es-CO')}`, 'FEE-' + baseRef]
            );

        // ════════════ LP COP (CDTC) ════════════
        } else {
            // LP COP: status 'active' directo (es registro admin), usa investment_returns para rendimientos.
            // annual_rate = 0 y se maneja por devengo mensual 2% como el resto de LP COP.
            const [result] = await connection.execute(
                `INSERT INTO investments 
                 (user_id, type, amount, annual_rate, duration_months, 
                  start_date, lock_end_date, invested_from_balance, status, notes) 
                 VALUES (?, 'CDTC', ?, 0, ?, ?, ?, 1, 'active', ?)`,
                [
                    userId, amount, months,
                    formatDate(startDate), formatDate(lockEndDate),
                    `[ADMIN] LP COP ${months}m — 2% mensual fijo. Inicio: ${formatDate(startDate)}, desbloqueo: ${formatDate(lockEndDate)}.${notes ? ' | ' + notes : ''}`,
                ]
            );
            investmentId = result.insertId;

            const refId = 'INV-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            await connection.execute(
                `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
                 VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
                [userId, investmentId, -amount, `Inversión LP COP a ${months} meses (admin) — Desbloqueo: ${formatDate(lockEndDate)}`, refId]
            );
        }

        // ── Recalcular balance del usuario ──
        const newBalance = await recalculateAndSaveBalance(connection, userId);

        // ── Audit log ──
        try {
            await auditLog({
                userId: req.user.id,
                action: 'admin_create_investment',
                entityType: 'investment',
                entityId: investmentId,
                details: { targetUserId: userId, type, amount, durationMonths: months, startDate: formatDate(startDate) },
                ipAddress: req.ip,
            });
        } catch (e) { /* audit best-effort */ }

        await connection.commit();

        return res.status(201).json({
            message: `Inversión ${type === 'pool' ? 'Fondo DGP' : 'LP COP'} creada exitosamente`,
            investment: {
                id: investmentId,
                userId,
                type: type === 'pool' ? 'pool' : 'CDTC',
                amount,
                durationMonths: months,
                startDate: formatDate(startDate),
                lockEndDate: formatDate(lockEndDate),
                newBalance,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error adminCreateInvestment:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};