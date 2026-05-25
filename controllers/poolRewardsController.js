// ══════════════════════════════════════════════════════════════════════
// controllers/poolRewardsController.js — Sanse Capital
// v1.2 — FIX: period_month es columna DATE en MySQL, necesita YYYY-MM-DD
//
// Maneja la RECOMPENSA MASIVA del Pool de Liquidez.
// Aplica una tasa única a TODAS las inversiones Pool activas en una
// sola transacción atómica.
//
// ESTILO POOL:
//   - Suma a withdrawable_earnings de cada inversión Pool
//   - NO crea transacción 'investment_return' (no toca balance)
//   - El cliente reclama cuando quiera vía /investments/:id/withdraw-earnings
// ══════════════════════════════════════════════════════════════════════

const { pool } = require('../config/database');
const { auditLog } = require('../utils/helpers');

// ───────────────────────────────────────────────────────────────────────
// HELPER: normalizar YYYY-MM → YYYY-MM-01 para columna DATE
// El frontend manda "2026-04" pero la columna period_month es DATE
// ───────────────────────────────────────────────────────────────────────
function normalizePeriodMonth(periodMonth) {
    if (!periodMonth) return null;
    const str = String(periodMonth).trim();
    // Si ya viene como YYYY-MM-DD lo dejamos
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    // Si viene como YYYY-MM lo convertimos a YYYY-MM-01
    if (/^\d{4}-\d{2}$/.test(str)) return str + '-01';
    return null; // formato inválido
}

// ───────────────────────────────────────────────────────────────────────
// GET /api/admin/pool/reward-preview?rate=X&periodMonth=YYYY-MM
// ───────────────────────────────────────────────────────────────────────
exports.previewBulkReward = async (req, res) => {
    try {
        const rate = parseFloat(req.query.rate);
        const periodMonthRaw = req.query.periodMonth;
        const periodMonth = normalizePeriodMonth(periodMonthRaw);

        if (!rate || isNaN(rate) || rate <= 0 || rate > 100) {
            return res.status(400).json({ error: 'Tasa inválida (0-100)' });
        }

        // Pools activos
        const [pools] = await pool.query(
            `SELECT id, user_id, amount, net_capital, withdrawable_earnings
             FROM investments
             WHERE LOWER(type) = 'pool' AND status = 'active'
             ORDER BY id ASC`
        );

        // Si hay periodMonth válido, verificar duplicados
        let alreadyPaid = [];
        if (periodMonth && pools.length > 0) {
            const ids = pools.map(p => p.id);
            try {
                const [paidRows] = await pool.query(
                    `SELECT investment_id FROM investment_returns
                     WHERE period_month = ? AND investment_id IN (?)`,
                    [periodMonth, ids]
                );
                alreadyPaid = paidRows.map(r => r.investment_id);
            } catch (e) {
                console.warn('[previewBulkReward] no se pudo verificar already paid:', e.message);
            }
        }

        const eligible = pools.filter(p => !alreadyPaid.includes(p.id));

        let totalCapital = 0;
        let totalGross = 0;

        const breakdown = eligible.map(p => {
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

        const referenceCommission = Math.round(totalGross * 0.20);
        const referenceNet = totalGross - referenceCommission;

        res.json({
            rate,
            periodMonth: periodMonthRaw || null,  // devolver tal cual lo mandó el cliente
            eligibleCount: eligible.length,
            skippedCount: alreadyPaid.length,
            skippedIds: alreadyPaid,
            totalCapital,
            totalGross,
            referenceCommission,
            referenceNet,
            breakdown,
        });
    } catch (e) {
        console.error('[previewBulkReward] ERROR:', e.message);
        console.error('[previewBulkReward] STACK:', e.stack);
        res.status(500).json({ error: 'Error interno del servidor', details: e.message });
    }
};

// ───────────────────────────────────────────────────────────────────────
// POST /api/admin/pool/pay-returns-bulk
// Body: { rate, periodMonth, notes? }
// ───────────────────────────────────────────────────────────────────────
exports.applyBulkReward = async (req, res) => {
    const { rate, periodMonth: periodMonthRaw, notes } = req.body;

    // Validaciones
    const r = parseFloat(rate);
    if (!r || isNaN(r) || r <= 0 || r > 100) {
        return res.status(400).json({ error: 'Tasa inválida (0-100)' });
    }
    if (!periodMonthRaw || !/^\d{4}-\d{2}(-\d{2})?$/.test(periodMonthRaw)) {
        return res.status(400).json({ error: 'periodMonth debe ser formato YYYY-MM o YYYY-MM-DD' });
    }

    const periodMonth = normalizePeriodMonth(periodMonthRaw);
    if (!periodMonth) {
        return res.status(400).json({ error: 'periodMonth con formato inválido' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Pools activos (con lock)
        const [pools] = await connection.query(
            `SELECT id, user_id, amount, net_capital
             FROM investments
             WHERE LOWER(type) = 'pool' AND status = 'active'
             FOR UPDATE`
        );

        if (!pools.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'No hay inversiones Pool activas' });
        }

        // 2. Verificar duplicados (usando query para IN(?))
        const ids = pools.map(p => p.id);
        const [paidRows] = await connection.query(
            `SELECT investment_id FROM investment_returns
             WHERE period_month = ? AND investment_id IN (?)`,
            [periodMonth, ids]
        );
        const alreadyPaidIds = new Set(paidRows.map(p => p.investment_id));

        const eligible = pools.filter(p => !alreadyPaidIds.has(p.id));

        if (!eligible.length) {
            await connection.rollback();
            return res.status(400).json({
                error: `Todas las inversiones Pool ya tienen rendimiento registrado para ${periodMonthRaw}`,
                skipped: pools.length,
            });
        }

        // 3. Procesar cada pool elegible
        const results = [];
        let totalGross = 0;

        for (const p of eligible) {
            const capital = parseFloat(p.net_capital || p.amount) || 0;
            const earned = Math.round(capital * (r / 100));

            if (earned <= 0) continue;

            // 3a. INSERT en investment_returns (period_month en formato YYYY-MM-DD)
            const [returnRes] = await connection.execute(
                `INSERT INTO investment_returns
                 (investment_id, user_id, period_month, rate_applied, amount_earned, status, notes)
                 VALUES (?, ?, ?, ?, ?, 'paid', ?)`,
                [
                    p.id,
                    p.user_id,
                    periodMonth,  // ← ya normalizado a YYYY-MM-01
                    r,
                    earned,
                    notes
                        ? `${notes} (bulk Pool ${r}%)`
                        : `Recompensa Pool ${r}% — ${periodMonthRaw} — bulk`,
                ]
            );

            // 3b. Sumar a withdrawable_earnings (no toca balance)
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

        // 4. Audit log (no bloquea si falla)
        try {
            await auditLog({
                userId: req.user.id,
                action: 'pool_bulk_reward',
                entityType: 'investment_returns',
                entityId: null,
                details: {
                    rate: r,
                    periodMonth: periodMonthRaw,
                    notes: notes || null,
                    pools: results.length,
                    skipped: alreadyPaidIds.size,
                    totalGross,
                },
                ipAddress: req.ip,
            });
        } catch (e) {
            console.error('[auditLog bulk reward]', e.message);
        }

        await connection.commit();

        res.json({
            success: true,
            message: `Recompensa aplicada a ${results.length} inversión${results.length === 1 ? '' : 'es'} Pool`,
            rate: r,
            periodMonth: periodMonthRaw,
            applied: results.length,
            skipped: alreadyPaidIds.size,
            skippedIds: Array.from(alreadyPaidIds),
            totalGross,
            referenceCommissionWhenClaimed: Math.round(totalGross * 0.20),
            referenceNetWhenClaimed: totalGross - Math.round(totalGross * 0.20),
            details: results,
        });
    } catch (e) {
        await connection.rollback();
        console.error('[applyBulkReward] ERROR:', e.message);
        console.error('[applyBulkReward] STACK:', e.stack);
        res.status(500).json({ error: 'Error interno del servidor', details: e.message });
    } finally {
        connection.release();
    }
};