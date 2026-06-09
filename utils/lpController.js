// ══════════════════════════════════════════════════════════════
// controllers/lpController.js — Sanse Capital
// Endpoints para el pago automático LP COP (CDTC):
//  • GET  /api/investments/lp/accrued        → resumen acumulado del usuario
//  • POST /api/investments/lp/claim           → reclamar acumulado (entra al balance)
//  • POST /api/admin/lp/run-accrual           → devengo manual de respaldo (admin)
//
// El devengo (status='accrued') NO toca transactions. Solo el Claim
// crea la transacción 'investment_return' que suma al balance retirable,
// aplicando la comisión de referido del 5% igual que registerInvestmentReturn.
// ══════════════════════════════════════════════════════════════

const { pool } = require('../config/database');
const { recalculateAndSaveBalance } = require('../utils/balanceHelper');
const { runMonthlyAccrual } = require('../utils/lpAccrual');

// ─────────────────────────────────────────────────────────────
// GET /api/investments/lp/accrued
// Cuánto tiene el usuario acumulado (sin reclamar) en sus LP COP.
// ─────────────────────────────────────────────────────────────
exports.getAccruedSummary = async (req, res) => {
    try {
        const userId = req.user.id;

        const [rows] = await pool.execute(
            `SELECT ir.id, ir.investment_id, ir.period_month, ir.rate_applied,
                    ir.amount_earned, ir.notes, ir.created_at,
                    i.type, i.amount AS capital
             FROM investment_returns ir
             JOIN investments i ON i.id = ir.investment_id
             WHERE ir.user_id = ? AND ir.status = 'accrued'
             ORDER BY ir.period_month ASC`,
            [userId]
        );

        const totalAccrued = rows.reduce((s, r) => s + parseFloat(r.amount_earned), 0);

        // Agrupado por inversión para que el frontend lo muestre por tarjeta.
        const byInvestment = {};
        for (const r of rows) {
            if (!byInvestment[r.investment_id]) {
                byInvestment[r.investment_id] = {
                    investmentId: r.investment_id,
                    capital: parseFloat(r.capital),
                    periods: [],
                    subtotal: 0,
                };
            }
            byInvestment[r.investment_id].periods.push({
                period: r.period_month,
                rate: parseFloat(r.rate_applied),
                amount: parseFloat(r.amount_earned),
                notes: r.notes,
            });
            byInvestment[r.investment_id].subtotal += parseFloat(r.amount_earned);
        }

        res.json({
            totalAccrued,
            count: rows.length,
            canClaim: totalAccrued > 0,
            byInvestment: Object.values(byInvestment),
        });
    } catch (error) {
        console.error('Error getAccruedSummary:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/investments/lp/claim
// Reclama TODO lo acumulado del usuario. Crea UNA transacción
// 'investment_return' por inversión (para mantener el vínculo
// investment_id) y marca los returns como 'paid'.
// Aplica comisión de referido 5% sobre el bruto reclamado.
// ─────────────────────────────────────────────────────────────
exports.claimAccrued = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const userId = req.user.id;

        // Bloqueo de filas para evitar doble-claim concurrente.
        const [accrued] = await connection.execute(
            `SELECT id, investment_id, period_month, amount_earned
             FROM investment_returns
             WHERE user_id = ? AND status = 'accrued'
             ORDER BY investment_id, period_month
             FOR UPDATE`,
            [userId]
        );

        if (!accrued.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'No tienes rendimientos acumulados para reclamar' });
        }

        // Agrupar montos e ids por inversión.
        const groups = {};
        for (const r of accrued) {
            if (!groups[r.investment_id]) groups[r.investment_id] = { gross: 0, ids: [], periods: [] };
            groups[r.investment_id].gross += parseFloat(r.amount_earned);
            groups[r.investment_id].ids.push(r.id);
            groups[r.investment_id].periods.push(r.period_month);
        }

        // ¿Tiene referidor? (comisión 5% como en registerInvestmentReturn)
        const [refRows] = await connection.execute('SELECT referred_by FROM users WHERE id = ?', [userId]);
        const referrerId = refRows.length ? refRows[0].referred_by : null;

        let totalNetToUser = 0;
        let totalReferral = 0;
        const claimedPeriods = [];

        for (const invId of Object.keys(groups)) {
            const g = groups[invId];
            const gross = Math.round(g.gross);
            const referralCommission = referrerId ? Math.round(gross * 0.05) : 0;
            const net = gross - referralCommission;

            // Marcar los devengos como pagados/reclamados.
            // mysql2: usar pool.query con IN (?) y array (execute falla con IN arrays).
            await connection.query(
                `UPDATE investment_returns
                 SET status = 'paid', claimed_at = NOW()
                 WHERE id IN (?)`,
                [g.ids]
            );

            // Transacción que SUMA al balance retirable.
            const refId = 'RET-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            const periodsLabel = g.periods.map((p) => String(p).slice(0, 7)).join(', ');
            await connection.execute(
                `INSERT INTO transactions (user_id, investment_id, type, amount, description, ref_id, created_at)
                 VALUES (?, ?, 'investment_return', ?, ?, ?, NOW())`,
                [userId, invId, net,
                 `Reclamo rendimientos LP COP — períodos: ${periodsLabel}${referralCommission ? ' (neto, -$' + referralCommission.toLocaleString('es-CO') + ' comisión referido)' : ''}`,
                 refId]
            );

            // Comisión al referidor (mismo patrón que el sistema actual).
            if (referrerId && referralCommission >= 100) {
                const referralRefId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
                try {
                    await connection.execute(
                        `INSERT INTO referral_commissions
                           (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id)
                         VALUES (?, ?, 'investment_return', ?, ?, 0.05, ?, 'paid', ?)`,
                        [referrerId, userId, invId, gross, referralCommission, referralRefId]
                    );
                } catch (e) { console.error('Error registrando comisión referido LP:', e.message); }

                await connection.execute(
                    `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
                     VALUES (?, 'profit', ?, ?, ?, NOW())`,
                    [referrerId, referralCommission, `Comisión referido — 5% de rendimiento LP COP`, referralRefId]
                );
                await recalculateAndSaveBalance(connection, referrerId);
                totalReferral += referralCommission;
            }

            totalNetToUser += net;
            claimedPeriods.push(...g.periods.map((p) => String(p).slice(0, 7)));
        }

        const newBalance = await recalculateAndSaveBalance(connection, userId);
        await connection.commit();

        res.json({
            message: 'Rendimientos reclamados y abonados a tu saldo disponible',
            claimed: {
                netToUser: totalNetToUser,
                referralCommission: totalReferral,
                periods: claimedPeriods,
                newBalance,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error claimAccrued:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/admin/lp/run-accrual
// Devengo manual de respaldo (botón en el panel admin).
// Corre el mismo proceso que el cron del día 1.
// ─────────────────────────────────────────────────────────────
exports.adminRunAccrual = async (req, res) => {
    try {
        const result = await runMonthlyAccrual(pool, new Date());
        res.json({
            message: 'Devengo mensual LP COP ejecutado',
            ...result,
        });
    } catch (error) {
        console.error('Error adminRunAccrual:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};