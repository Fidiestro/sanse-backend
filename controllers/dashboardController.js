const { pool } = require('../config/database');

// GET /api/dashboard/summary — Resumen completo para el dashboard del usuario
exports.getSummary = async (req, res) => {
    try {
        const userId = req.user.id;

        // 1. Balance actual (último registro de balance_history)
        const [balanceRows] = await pool.execute(
            `SELECT balance, recorded_at FROM balance_history 
             WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1`,
            [userId]
        );
        const currentBalance = balanceRows.length > 0 ? parseFloat(balanceRows[0].balance) : 0;

        // 2. Inversiones activas
        const [investments] = await pool.execute(
            `SELECT id, type, amount, annual_rate, start_date, status 
             FROM investments WHERE user_id = ? AND status = 'active' 
             ORDER BY start_date DESC`,
            [userId]
        );

        // 3. Últimas transacciones (últimas 20)
        const [transactions] = await pool.execute(
            `SELECT id, type, amount, description, created_at 
             FROM transactions WHERE user_id = ? 
             ORDER BY created_at DESC LIMIT 20`,
            [userId]
        );

        // 4. Historial de balance (últimos 6 meses)
        const [balanceHistory] = await pool.execute(
            `SELECT balance, recorded_at FROM balance_history 
             WHERE user_id = ? ORDER BY recorded_at ASC`,
            [userId]
        );

        // 5. Préstamos activos
        const [loans] = await pool.execute(
            `SELECT id, amount, monthly_rate, start_date, status 
             FROM loans WHERE user_id = ? AND status = 'active'`,
            [userId]
        );

        // Cálculos
        const totalInvested = investments.reduce((sum, i) => sum + parseFloat(i.amount), 0);
        const totalProfit = transactions
            .filter(t => t.type === 'profit')
            .reduce((sum, t) => sum + parseFloat(t.amount), 0);
        const activeInvestments = investments.filter(i => i.status === 'active').length;
        const rates = investments.map(i => parseFloat(i.annual_rate));
        const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
        const lastProfit = transactions.find(t => t.type === 'profit');
        const monthlyGoal = parseFloat(req.user.monthly_goal) || 20000000;

        // Primera transacción para calcular meses
        const [firstTx] = await pool.execute(
            `SELECT created_at FROM transactions WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`,
            [userId]
        );
        const monthsInvesting = firstTx.length > 0
            ? Math.max(1, Math.round((new Date() - new Date(firstTx[0].created_at)) / (1000 * 60 * 60 * 24 * 30)))
            : 0;

        res.json({
            balance: currentBalance,
            monthlyGoal,
            totalInvested,
            totalProfit,
            activeInvestments,
            avgRate: parseFloat(avgRate.toFixed(1)),
            monthsInvesting,
            lastProfit: lastProfit ? parseFloat(lastProfit.amount) : 0,
            investments: investments.map(i => ({
                id: i.id,
                type: i.type,
                amount: parseFloat(i.amount),
                rate: parseFloat(i.annual_rate),
                date: i.start_date,
                status: i.status,
            })),
            transactions: transactions.map(t => ({
                id: t.id,
                type: t.type,
                amount: parseFloat(t.amount),
                description: t.description,
                date: t.created_at,
            })),
            balanceHistory: balanceHistory.map(b => ({
                amount: parseFloat(b.balance),
                date: b.recorded_at,
            })),
            loans: loans.map(l => ({
                id: l.id,
                amount: parseFloat(l.amount),
                monthlyRate: parseFloat(l.monthly_rate),
                date: l.start_date,
                status: l.status,
            })),
        });
    } catch (error) {
        console.error('Error obteniendo resumen del dashboard:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};
