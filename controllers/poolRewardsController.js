// ══════════════════════════════════════════════════════════════════════
// controllers/poolRewardsController.js — Sanse Capital
//
// Maneja la RECOMPENSA MASIVA del Pool de Liquidez.
// En lugar de registrar rendimiento uno por uno (como hace
// adminController.registerInvestmentReturn para CDTC), aplica una
// tasa única a TODAS las inversiones Pool activas en una sola
// transacción atómica.
//
// COMPORTAMIENTO ESTILO POOL:
//   - Suma a withdrawable_earnings de cada inversión Pool
//   - NO crea transacción 'investment_return' (no toca balance)
//   - El cliente reclama cuando quiera vía /investments/:id/withdraw-earnings
//   - Esa ruta es la que descuenta 20% comisión Sanse y suma al balance
//
// SEGURIDAD:
//   - Transacción atómica: si falla 1 pool, ROLLBACK de TODO
//   - Valida que no haya rendimiento duplicado del mismo mes
//   - Solo inversiones con status = 'active' (NO pending_deposit)
//   - Capital base se calcula del net_capital (ya descuenta la comisión 2% entrada)
// ══════════════════════════════════════════════════════════════════════

const { pool } = require('../config/database');
const { auditLog } = require('../utils/helpers');

// ───────────────────────────────────────────────────────────────────────
// GET /api/admin/pool/reward-preview?rate=X&periodMonth=YYYY-MM
// Devuelve cálculo en vivo SIN aplicar nada. Para el preview del admin.
// ───────────────────────────────────────────────────────────────────────
exports.previewBulkReward = async (req, res) => {
    try {
        const rate = parseFloat(req.query.rate);
        const periodMonth = req.query.periodMonth; // YYYY-MM

        if (!rate || isNaN(rate) || rate <= 0 || rate > 100) {
            return res.status(400).json({ error: 'Tasa inválida (0-100)' });
        }

        // Pools activos
        const [pools] = await pool.execute(
            `SELECT id, user_id, amount, net_capital, withdrawable_earnings
             FROM investments
             WHERE LOWER(type) = 'pool' AND status = 'active'
             ORDER BY id ASC`
        );

        // Si periodMonth viene, identificar cuáles YA tienen rendimiento ese mes
        let alreadyPaid = [];
        if (periodMonth) {
            const ids = pools.map(p => p.id);
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                const [paidRows] = await pool.execute(
                    `SELECT investment_id FROM investment_returns
                     WHERE period_month = ? AND investment_id IN (${placeholders})`,
                    [periodMonth, ...ids]
                );
                alreadyPaid = paidRows.map(r => r.investment_id);
            }
        }

        const eligible = pools.filter(p => !alreadyPaid.includes(p.id));

        let totalCapital = 0;
        let totalGross = 0;

        const breakdown = eligible.map(p => {
            // Usar net_capital si está, si no usar amount
            const capital = parseFloat(p.net_capital || p.amount) || 0;
            const earned = Math.round(capital * (rate / 100));
            totalCapital += capital;
            totalGross += earned;
            return {
                investmentId: p.id,
                userId: p.user_id,
                capital,
                earnedGross: earned,
            };
        });

        // Comisión Sanse 20% (solo se aplica cuando el cliente RECLAMA, no ahora)
        // La mostramos en el preview como referencia informativa.
        const referenceCommission = Math.round(totalGross * 0.20);
        const referenceNet = totalGross - referenceCommission;

        res.json({
            rate,
            periodMonth: periodMonth || null,
            eligibleCount: eligible.length,
            skippedCount: alreadyPaid.length,
            skippedIds: alreadyPaid,
            totalCapital,
            totalGross,
            referenceCommission,  // info: lo que Sanse cobrará cuando todos reclamen
            referenceNet,         // info: neto total a usuarios
            breakdown,
        });
    } catch (e) {
        console.error('[previewBulkReward]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// POST /api/admin/pool/pay-returns-bulk
// Body: { rate, periodMonth, notes? }
// Aplica la tasa a todos los pools activos. Atómico.
// ───────────────────────────────────────────────────────────────────────
exports.applyBulkReward = async (req, res) => {
    const { rate, periodMonth, notes } = req.body;

    // Validaciones
    const r = parseFloat(rate);
    if (!r || isNaN(r) || r <= 0 || r > 100) {
        return res.status(400).json({ error: 'Tasa inválida (0-100)' });
    }
    if (!periodMonth || !/^\d{4}-\d{2}$/.test(periodMonth)) {
        return res.status(400).json({ error: 'periodMonth debe ser formato YYYY-MM' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Obtener todos los pools activos
        const [pools] = await connection.execute(
            `SELECT id, user_id, amount, net_capital
             FROM investments
             WHERE LOWER(type) = 'pool' AND status = 'active'
             FOR UPDATE`  // Lock para evitar race conditions
        );

        if (!pools.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'No hay inversiones Pool activas' });
        }

        // 2. Verificar cuáles ya tienen rendimiento este mes
        const ids = pools.map(p => p.id);
        const placeholders = ids.map(() => '?').join(',');
        const [paidRows] = await connection.execute(
            `SELECT investment_id FROM investment_returns
             WHERE period_month = ? AND investment_id IN (${placeholders})`,
            [periodMonth, ...ids]
        );
        const alreadyPaidIds = new Set(paidRows.map(p => p.investment_id));

        const eligible = pools.filter(p => !alreadyPaidIds.has(p.id));

        if (!eligible.length) {
            await connection.rollback();
            return res.status(400).json({
                error: `Todas las inversiones Pool ya tienen rendimiento registrado para ${periodMonth}`,
                skipped: pools.length,
            });
        }

        // 3. Procesar cada pool elegible
        const results = [];
        let totalGross = 0;

        for (const p of eligible) {
            const capital = parseFloat(p.net_capital || p.amount) || 0;
            const earned = Math.round(capital * (r / 100));

            if (earned <= 0) continue; // Skip si el cálculo da 0 (capital 0)

            // 3a. Registrar en investment_returns
            const [returnRes] = await connection.execute(
                `INSERT INTO investment_returns
                 (investment_id, user_id, period_month, rate_applied, amount_earned, status, notes)
                 VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
                [
                    p.id,
                    p.user_id,
                    periodMonth,
                    r,
                    earned,
                    notes
                        ? `${notes} (bulk Pool ${r}%)`
                        : `Recompensa Pool ${r}% — ${periodMonth} — bulk`,
                ]
            );

            // 3b. Sumar a withdrawable_earnings (estilo Pool, no toca balance)
            await connection.execute(
                `UPDATE investments
                 SET withdrawable_earnings = COALESCE(withdrawable_earnings, 0) + ?
                 WHERE id = ?`,
                [earned, p.id]
            );

            totalGross += earned;
            results.push({
                investmentId: p.id,
                userId: p.user_id,
                capital,
                earned,
                returnId: returnRes.insertId,
            });
        }

        // 4. Audit log
        try {
            await auditLog({
                userId: req.user.id,
                action: 'pool_bulk_reward',
                entityType: 'investment_returns',
                entityId: null,
                details: {
                    rate: r,
                    periodMonth,
                    notes: notes || null,
                    pools: results.length,
                    skipped: alreadyPaidIds.size,
                    totalGross,
                },
                ipAddress: req.ip,
            });
        } catch (e) {
            // No bloqueamos el flujo principal por un fallo de audit
            console.error('[auditLog bulk reward]', e.message);
        }

        await connection.commit();

        res.json({
            success: true,
            message: `Recompensa aplicada a ${results.length} inversión${results.length === 1 ? '' : 'es'} Pool`,
            rate: r,
            periodMonth,
            applied: results.length,
            skipped: alreadyPaidIds.size,
            skippedIds: Array.from(alreadyPaidIds),
            totalGross,
            // info: comisión 20% se aplicará cuando el usuario reclame
            referenceCommissionWhenClaimed: Math.round(totalGross * 0.20),
            referenceNetWhenClaimed: totalGross - Math.round(totalGross * 0.20),
            details: results,
        });
    } catch (e) {
        await connection.rollback();
        console.error('[applyBulkReward]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};