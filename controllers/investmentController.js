const { pool } = require('../config/database');
const { auditLog } = require('../utils/helpers');

// GET /api/investments/available — Productos de inversión disponibles
exports.getAvailableProducts = async (req, res) => {
    try {
        const products = [
            {
                id: 'sdtc_6m',
                name: 'Inversión SDTC',
                description: 'Certificado de depósito a término con rendimiento variable mensual',
                durationMonths: 6,
                minMonthlyRate: 2.0,
                maxMonthlyRate: 4.0,
                minAmount: 100000,
                maxAmount: null,
                features: [
                    'Plazo fijo de 6 meses',
                    'Rendimiento mensual variable entre 2% y 4%',
                    'Capital bloqueado hasta vencimiento',
                    'Rendimientos se acumulan al capital',
                ],
            },
        ];
        res.json(products);
    } catch (error) {
        console.error('Error obteniendo productos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/investments/create — Usuario crea inversión SDTC desde su balance disponible
exports.createUserInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const { productId, amount } = req.body;

        if (!productId || !amount) {
            return res.status(400).json({ error: 'productId y amount son requeridos' });
        }
        if (productId !== 'sdtc_6m') {
            return res.status(400).json({ error: 'Producto no disponible' });
        }
        if (amount < 100000) {
            return res.status(400).json({ error: 'Monto mínimo de inversión: $100.000 COP' });
        }

        // 1. Calcular balance disponible del usuario
        const [balanceRows] = await connection.execute(
            `SELECT amount FROM balance_history WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`,
            [userId]
        );
        const currentBalance = balanceRows.length > 0 ? parseFloat(balanceRows[0].amount) : 0;

        // 2. Calcular total invertido activamente
        const [investedRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status = 'active'`,
            [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);
        const availableBalance = currentBalance - totalInvested;

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Saldo disponible insuficiente. Disponible: $${Math.round(availableBalance).toLocaleString('es-CO')} COP`,
                available: availableBalance,
            });
        }

        // 3. Calcular fechas
        const startDate = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 6);
        const lockEndDate = new Date(endDate);

        const formatDate = (d) => d.toISOString().slice(0, 10);

        // 4. Crear la inversión
        const [result] = await connection.execute(
            `INSERT INTO investments 
             (user_id, type, amount, annual_rate, duration_months, min_monthly_rate, max_monthly_rate, 
              start_date, end_date, lock_end_date, invested_from_balance, status, notes) 
             VALUES (?, 'SDTC', ?, 0, 6, 2.00, 4.00, ?, ?, ?, 1, 'active', ?)`,
            [
                userId,
                amount,
                formatDate(startDate),
                formatDate(endDate),
                formatDate(lockEndDate),
                `Inversión SDTC creada por usuario. Desbloqueo: ${formatDate(lockEndDate)}`,
            ]
        );

        const investmentId = result.insertId;

        // 5. Registrar transacción
        const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM transactions');
        const refId = 'INV-' + String(countRows[0].c + 1).padStart(5, '0');

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
            [userId, investmentId, amount, `Inversión SDTC a 6 meses — Desbloqueo: ${formatDate(lockEndDate)}`, refId]
        );

        // 6. Audit log
        await auditLog({
            userId,
            action: 'create_investment',
            entityType: 'investment',
            entityId: investmentId,
            details: { type: 'SDTC', amount, durationMonths: 6, lockEndDate: formatDate(lockEndDate) },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.status(201).json({
            message: 'Inversión SDTC creada exitosamente',
            investment: {
                id: investmentId,
                type: 'SDTC',
                amount,
                startDate: formatDate(startDate),
                endDate: formatDate(endDate),
                lockEndDate: formatDate(lockEndDate),
                minMonthlyRate: 2.0,
                maxMonthlyRate: 4.0,
                status: 'active',
                refId,
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

// ══════════════════════════════════════════════════════════════
// POST /api/investments/:id/add-capital — Agregar capital a inversión existente
// La fecha de vencimiento NO cambia, solo aumenta el monto invertido
// ══════════════════════════════════════════════════════════════
exports.addCapitalToInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const investmentId = req.params.id;
        const { amount } = req.body;

        if (!amount || amount < 50000) {
            return res.status(400).json({ error: 'Monto mínimo para agregar: $50.000 COP' });
        }

        // 1. Verificar que la inversión existe, es del usuario, y está activa
        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND user_id = ? AND status = 'active'`,
            [investmentId, userId]
        );
        if (!invRows.length) {
            return res.status(404).json({ error: 'Inversión no encontrada o no está activa' });
        }
        const inv = invRows[0];

        // 2. Verificar que no haya vencido
        const now = new Date();
        const lockEnd = new Date(inv.lock_end_date || inv.end_date);
        if (now >= lockEnd) {
            return res.status(400).json({ error: 'No se puede agregar capital a una inversión vencida. Retírala y crea una nueva.' });
        }

        // 3. Verificar balance disponible
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

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Saldo disponible insuficiente. Disponible: $${Math.round(availableBalance).toLocaleString('es-CO')} COP`,
                available: availableBalance,
            });
        }

        // 4. Actualizar monto (NO cambia lock_end_date ni end_date)
        const previousAmount = parseFloat(inv.amount);
        const newAmount = previousAmount + amount;
        const addedDate = now.toISOString().slice(0, 10);

        await connection.execute(
            `UPDATE investments SET amount = ? WHERE id = ?`,
            [newAmount, investmentId]
        );

        // 5. Registrar transacción
        const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM transactions');
        const refId = 'ADD-' + String(countRows[0].c + 1).padStart(5, '0');

        const lockDateStr = (inv.lock_end_date || inv.end_date).toString().slice(0, 10);

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment', ?, ?, ?, NOW())`,
            [userId, investmentId, amount, `Capital adicional SDTC #${investmentId} — Mismo vencimiento: ${lockDateStr}`, refId]
        );

        // 6. Audit log
        await auditLog({
            userId,
            action: 'add_capital',
            entityType: 'investment',
            entityId: parseInt(investmentId),
            details: { previousAmount, addedAmount: amount, newAmount, lockEndDate: lockDateStr },
            ipAddress: req.ip,
        });

        await connection.commit();

        res.json({
            message: 'Capital agregado exitosamente',
            investment: {
                id: parseInt(investmentId),
                previousAmount,
                addedAmount: amount,
                newAmount,
                lockEndDate: lockDateStr,
                refId,
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

// ══════════════════════════════════════════════════════════════
// POST /api/investments/:id/withdraw — Retirar inversión vencida
// Solo funciona si lock_end_date ya pasó
// Cambia status a 'completed' y el capital vuelve al disponible
// ══════════════════════════════════════════════════════════════
exports.withdrawInvestment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const investmentId = req.params.id;

        // 1. Verificar inversión
        const [invRows] = await connection.execute(
            `SELECT * FROM investments WHERE id = ? AND user_id = ? AND status = 'active'`,
            [investmentId, userId]
        );
        if (!invRows.length) {
            return res.status(404).json({ error: 'Inversión no encontrada o no está activa' });
        }
        const inv = invRows[0];

        // 2. Verificar que ya venció
        const now = new Date();
        const lockEnd = new Date(inv.lock_end_date || inv.end_date);
        if (now < lockEnd) {
            const daysLeft = Math.ceil((lockEnd - now) / (1000 * 60 * 60 * 24));
            return res.status(400).json({
                error: `La inversión aún no ha vencido. Faltan ${daysLeft} días para el desbloqueo.`,
                daysRemaining: daysLeft,
                lockEndDate: lockEnd.toISOString().slice(0, 10),
            });
        }

        // 3. Capital a devolver
        const capitalAmount = parseFloat(inv.amount);

        // 4. Marcar inversión como completada
        await connection.execute(
            `UPDATE investments SET status = 'completed' WHERE id = ?`,
            [investmentId]
        );

        // 5. NO necesita transacción extra: al cambiar a completed, el amount
        // ya no se cuenta como "invertido", así que automáticamente vuelve al disponible
        // Pero registramos una transacción informativa
        const [countRows] = await connection.execute('SELECT COUNT(*) as c FROM transactions');
        const refId = 'WDR-' + String(countRows[0].c + 1).padStart(5, '0');

        await connection.execute(
            `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at) 
             VALUES (?, ?, 'investment_withdrawal', ?, ?, ?, NOW())`,
            [userId, investmentId, capitalAmount, `Retiro inversión SDTC #${investmentId} — Capital liberado`, refId]
        );

        // 6. Audit log
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

// GET /api/investments/my — Inversiones del usuario con detalle
exports.getMyInvestments = async (req, res) => {
    try {
        const userId = req.user.id;

        const [investments] = await pool.execute(
            `SELECT id, type, amount, annual_rate, duration_months, min_monthly_rate, max_monthly_rate,
                    start_date, end_date, lock_end_date, status, notes, created_at
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

                const totalEarned = returns.reduce((sum, r) => sum + parseFloat(r.amount_earned), 0);
                const now = new Date();
                const end = new Date(inv.lock_end_date || inv.end_date);
                const start = new Date(inv.start_date);
                const totalDays = Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
                const elapsedDays = Math.max(0, (now - start) / (1000 * 60 * 60 * 24));
                const progressPct = Math.min(100, Math.round((elapsedDays / totalDays) * 100));
                const daysRemaining = Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));
                const isMatured = now >= end;

                return {
                    id: inv.id,
                    type: inv.type,
                    amount: parseFloat(inv.amount),
                    annualRate: parseFloat(inv.annual_rate),
                    durationMonths: inv.duration_months,
                    minMonthlyRate: parseFloat(inv.min_monthly_rate || 0),
                    maxMonthlyRate: parseFloat(inv.max_monthly_rate || 0),
                    startDate: inv.start_date,
                    endDate: inv.end_date,
                    lockEndDate: inv.lock_end_date,
                    status: inv.status,
                    notes: inv.notes,
                    progressPct,
                    daysRemaining,
                    totalEarned,
                    isMatured,
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

// GET /api/investments/:id — Detalle de una inversión específica
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
             FROM transactions WHERE investment_id = ? ORDER BY created_at ASC`,
            [investmentId]
        );

        res.json({
            investment: {
                id: inv.id,
                type: inv.type,
                amount: parseFloat(inv.amount),
                durationMonths: inv.duration_months,
                minMonthlyRate: parseFloat(inv.min_monthly_rate || 0),
                maxMonthlyRate: parseFloat(inv.max_monthly_rate || 0),
                startDate: inv.start_date,
                endDate: inv.end_date,
                lockEndDate: inv.lock_end_date,
                status: inv.status,
                notes: inv.notes,
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
                date: t.created_at,
            })),
        });
    } catch (error) {
        console.error('Error obteniendo detalle:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// GET /api/investments/balance-summary — Resumen de balance para el dashboard
exports.getBalanceSummary = async (req, res) => {
    try {
        const userId = req.user.id;

        const [balanceRows] = await pool.execute(
            `SELECT amount FROM balance_history WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`,
            [userId]
        );
        const totalBalance = balanceRows.length > 0 ? parseFloat(balanceRows[0].amount) : 0;

        const [investedRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status = 'active'`,
            [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);

        const [earningsRows] = await pool.execute(
            `SELECT COALESCE(SUM(amount_earned), 0) as total FROM investment_returns WHERE user_id = ?`,
            [userId]
        );
        const totalEarnings = parseFloat(earningsRows[0].total);

        const availableBalance = totalBalance - totalInvested;

        res.json({
            totalBalance,
            totalInvested,
            availableBalance: Math.max(0, availableBalance),
            totalEarnings,
        });
    } catch (error) {
        console.error('Error balance summary:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};
