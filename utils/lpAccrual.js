// ══════════════════════════════════════════════════════════════
// utils/lpAccrual.js — Sanse Capital
// Devengo automático de rendimientos LP COP (CDTC).
//
// Reglas de negocio (confirmadas):
//  • 2% mensual fijo sobre el CAPITAL invertido (interés simple).
//  • El devengo ocurre el día 1 de cada mes, por el mes ANTERIOR.
//  • Si la inversión se abrió a mitad de un mes, el PRIMER período
//    se prorratea por días reales:
//        rendimiento = capital * 2% * (díasActivos / díasDelMesAnterior)
//  • Cada devengo se guarda en investment_returns con status='accrued'.
//    NO toca la tabla transactions → no entra al balance retirable
//    hasta que el usuario haga Claim.
//  • Idempotente: usa investments.last_accrual_period para no repetir.
//
// Este módulo NO conoce de HTTP. Recibe una conexión/pool y trabaja.
// ══════════════════════════════════════════════════════════════

const MONTHLY_RATE = 2.0; // % mensual fijo LP COP

// Devuelve true si la inversión es LP COP / CDTC (no Pool).
function isLpCop(inv) {
    const t = (inv.type || 'cdtc').toString().toLowerCase();
    return t === 'cdtc' || t === 'lp_cop' || t === 'lpcop';
}

// Primer día del mes de una fecha → Date (UTC, a medianoche).
function firstOfMonth(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

// Días en el mes de una fecha dada.
function daysInMonth(year, monthIndex0) {
    return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

// 'YYYY-MM-01' a partir de un Date (clave de período).
function periodKey(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
}

// Etiqueta legible 'YYYY-MM'.
function periodLabel(periodKeyStr) {
    return periodKeyStr.slice(0, 7);
}

/**
 * Calcula la lista de períodos pendientes de devengar para UNA inversión,
 * hasta (sin incluir) el mes de `asOf` — es decir, solo meses YA cerrados.
 *
 * @param {object} inv  - fila de investments (amount, start_date, last_accrual_period)
 * @param {Date}   asOf - fecha de referencia (normalmente "hoy"). El devengo
 *                        cubre todos los meses cerrados antes del mes de asOf.
 * @returns {Array<{periodKey, periodLabel, amount, isProrated, days, daysInBase}>}
 */
function computePendingPeriods(inv, asOf) {
    const capital = parseFloat(inv.amount) || 0;
    if (capital <= 0) return [];

    const start = new Date(inv.start_date);
    if (isNaN(start.getTime())) return [];

    // El mes "corriente" (el de asOf) aún no se cierra → tope exclusivo.
    const currentMonthStart = firstOfMonth(asOf);

    // Punto de arranque: si nunca se devengó, desde el mes de inicio;
    // si ya se devengó algo, desde el mes siguiente al último devengado.
    let cursor;
    if (inv.last_accrual_period) {
        const last = new Date(inv.last_accrual_period);
        cursor = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1));
    } else {
        cursor = firstOfMonth(start);
    }

    const periods = [];
    // Recorre mes a mes mientras el mes esté CERRADO (cursor < mes actual).
    while (cursor < currentMonthStart) {
        const pKey = periodKey(cursor);
        const label = periodLabel(pKey);
        const dim = daysInMonth(cursor.getUTCFullYear(), cursor.getUTCMonth());

        // ¿Es el mes en que arrancó la inversión? → prorratear por días reales.
        const sameMonthAsStart =
            cursor.getUTCFullYear() === start.getUTCFullYear() &&
            cursor.getUTCMonth() === start.getUTCMonth();

        let amount, isProrated, days;
        if (sameMonthAsStart) {
            // Días activos = desde el día de apertura hasta fin de ese mes (inclusive el día 1 del siguiente no cuenta).
            const startDay = start.getUTCDate(); // 1..31
            days = dim - startDay + 1; // si abrió el 1 → mes completo
            if (days < 0) days = 0;
            isProrated = days < dim;
            amount = Math.round(capital * (MONTHLY_RATE / 100) * (days / dim));
        } else {
            days = dim;
            isProrated = false;
            amount = Math.round(capital * (MONTHLY_RATE / 100));
        }

        if (amount > 0) {
            periods.push({ periodKey: pKey, periodLabel: label, amount, isProrated, days, daysInBase: dim });
        }

        // avanzar un mes
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }

    return periods;
}

/**
 * Devenga (inserta como 'accrued') los períodos pendientes de UNA inversión.
 * Usa la conexión transaccional provista por el llamador.
 * NO toca transactions. NO recalcula balance (el balance solo cambia en el Claim).
 *
 * @returns {{ inserted: number, totalAccrued: number, periods: string[] }}
 */
async function accrueInvestment(connection, inv, asOf = new Date()) {
    if (!isLpCop(inv)) return { inserted: 0, totalAccrued: 0, periods: [] };
    if (inv.status !== 'active') return { inserted: 0, totalAccrued: 0, periods: [] };

    const pending = computePendingPeriods(inv, asOf);
    if (!pending.length) return { inserted: 0, totalAccrued: 0, periods: [] };

    let inserted = 0;
    let totalAccrued = 0;
    const doneLabels = [];
    let lastKey = inv.last_accrual_period ? periodKey(new Date(inv.last_accrual_period)) : null;

    for (const p of pending) {
        // Guard anti-duplicado: ¿ya existe un return para este período?
        const [exists] = await connection.execute(
            `SELECT id FROM investment_returns WHERE investment_id = ? AND period_month = ?`,
            [inv.id, p.periodLabel]
        );
        if (exists.length) {
            lastKey = p.periodKey; // ya estaba; igual avanzamos el cursor
            continue;
        }

        const note = p.isProrated
            ? `Devengo LP COP prorrateado ${p.periodLabel} (${p.days}/${p.daysInBase} días) @ ${MONTHLY_RATE}% — pendiente de reclamo`
            : `Devengo LP COP ${p.periodLabel} @ ${MONTHLY_RATE}% — pendiente de reclamo`;

        await connection.execute(
            `INSERT INTO investment_returns
               (investment_id, user_id, period_month, rate_applied, amount_earned, status, notes)
             VALUES (?, ?, ?, ?, ?, 'accrued', ?)`,
            [inv.id, inv.user_id, p.periodLabel, MONTHLY_RATE, p.amount, note]
        );

        inserted += 1;
        totalAccrued += p.amount;
        doneLabels.push(p.periodLabel);
        lastKey = p.periodKey;
    }

    // Avanzar el marcador idempotente al último período cubierto.
    if (lastKey) {
        await connection.execute(
            `UPDATE investments SET last_accrual_period = ? WHERE id = ?`,
            [lastKey, inv.id]
        );
    }

    return { inserted, totalAccrued, periods: doneLabels };
}

/**
 * Recorre TODAS las inversiones LP COP activas y las devenga.
 * Cada inversión se procesa en su propia transacción (un fallo aislado
 * no detiene al resto).
 *
 * @param {object} pool - pool mysql2 (config/database)
 * @param {Date}   asOf - fecha de referencia
 * @returns {{ processed, totalAccrued, totalReturns, errors }}
 */
async function runMonthlyAccrual(pool, asOf = new Date()) {
    const [invs] = await pool.execute(
        `SELECT id, user_id, type, amount, status, start_date, last_accrual_period
         FROM investments
         WHERE status = 'active'
           AND (LOWER(type) = 'cdtc' OR LOWER(type) = 'lp_cop' OR LOWER(type) = 'lpcop' OR type IS NULL)`
    );

    let processed = 0;
    let totalAccrued = 0;
    let totalReturns = 0;
    const errors = [];

    for (const inv of invs) {
        if (!isLpCop(inv)) continue;
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const r = await accrueInvestment(connection, inv, asOf);
            await connection.commit();
            if (r.inserted > 0) {
                processed += 1;
                totalAccrued += r.totalAccrued;
                totalReturns += r.inserted;
            }
        } catch (e) {
            await connection.rollback();
            console.error(`[lpAccrual] error inversión ${inv.id}:`, e.message);
            errors.push({ investmentId: inv.id, error: e.message });
        } finally {
            connection.release();
        }
    }

    return { processed, totalAccrued, totalReturns, errors };
}

module.exports = {
    MONTHLY_RATE,
    isLpCop,
    computePendingPeriods,
    accrueInvestment,
    runMonthlyAccrual,
    firstOfMonth,
    daysInMonth,
    periodKey,
};