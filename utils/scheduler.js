// ══════════════════════════════════════════════════════════════
// utils/scheduler.js — Sanse Capital
// Scheduler interno SIN dependencias externas (no requiere node-cron).
// Revisa cada hora si es día 1 del mes y, de serlo, dispara el devengo
// mensual de LP COP una sola vez por mes (idempotente por naturaleza:
// lpAccrual usa last_accrual_period, así que aunque corra de más no
// duplica nada).
//
// Se arranca desde server.js con startScheduler(pool).
// ══════════════════════════════════════════════════════════════

const { runMonthlyAccrual } = require('./lpAccrual');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // cada hora
let lastRunMonthKey = null; // 'YYYY-MM' del último mes ya disparado en esta instancia

function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function tick(pool) {
    const now = new Date();
    const isFirstOfMonth = now.getDate() === 1;
    const thisMonth = monthKey(now);

    if (!isFirstOfMonth) return;
    if (lastRunMonthKey === thisMonth) return; // ya corrió este mes en esta instancia

    try {
        console.log(`🗓️  [scheduler] Día 1 detectado — devengando LP COP para ${thisMonth}...`);
        const result = await runMonthlyAccrual(pool, now);
        lastRunMonthKey = thisMonth;
        console.log(`✅ [scheduler] LP COP devengado: ${result.processed} inversiones, ${result.totalReturns} períodos, $${Math.round(result.totalAccrued).toLocaleString('es-CO')} acumulado${result.errors.length ? ` (${result.errors.length} errores)` : ''}`);
    } catch (e) {
        console.error('💥 [scheduler] Error en devengo LP COP:', e.message);
        // No marcamos lastRunMonthKey → reintenta en el próximo tick (1h).
    }
}

/**
 * Arranca el scheduler. Llamar UNA vez desde server.js tras app.listen.
 * @param {object} pool - pool mysql2 (config/database)
 */
function startScheduler(pool) {
    if (!pool) {
        console.warn('⚠️ [scheduler] pool no disponible, scheduler no iniciado');
        return;
    }
    // Primer chequeo a los 30s del arranque (por si el deploy cae justo el día 1).
    setTimeout(() => tick(pool).catch(() => {}), 30 * 1000);
    // Luego cada hora.
    setInterval(() => tick(pool).catch(() => {}), CHECK_INTERVAL_MS);
    console.log('⏰ [scheduler] Scheduler LP COP iniciado (chequeo horario, devengo el día 1)');
}

module.exports = { startScheduler };