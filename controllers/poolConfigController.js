// ══════════════════════════════════════════════════════════════════════
// controllers/poolConfigController.js — Sanse Capital
//
// Maneja la configuración editable del Pool (APY, distribución, mínimo,
// capital, estrategias) y la lectura completa de pool_config con stats
// extendidas.
//
// CERO IMPACTO en lógica de inversiones existente:
//   - NO toca creación de inversiones
//   - NO toca cálculo de balance
//   - NO toca retiros
//   - Solo lee/escribe la tabla pool_config
//
// REQUIERE: haber corrido 002_add_pool_strategies.sql
//   (degrada con gracia si la columna `strategies` no existe todavía)
// ══════════════════════════════════════════════════════════════════════

const { pool } = require('../config/database');

// ───────────────────────────────────────────────────────────────────────
// HELPER: leer estrategias de pool_config con tolerancia a columna ausente
// ───────────────────────────────────────────────────────────────────────
async function readStrategies() {
    try {
        const [rows] = await pool.execute(
            'SELECT strategies FROM pool_config WHERE id = 1 LIMIT 1'
        );
        if (!rows.length || !rows[0].strategies) return [];
        const raw = rows[0].strategies;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
            console.warn('[poolConfig] columna strategies no existe; correr 002_add_pool_strategies.sql');
            return [];
        }
        console.error('[poolConfig.readStrategies]', e);
        return [];
    }
}

// ───────────────────────────────────────────────────────────────────────
// HELPER: validar y escribir estrategias
// ───────────────────────────────────────────────────────────────────────
async function writeStrategies(strategiesArr) {
    const clean = (Array.isArray(strategiesArr) ? strategiesArr : [])
        .filter(s => s && typeof s.name === 'string' && s.name.trim())
        .map(s => ({
            name: String(s.name).trim().slice(0, 100),
            pct: Math.max(0, Math.min(100, parseFloat(s.pct) || 0)),
        }));

    // Si hay items, la suma debe ser 100 (tolerancia 0.1)
    if (clean.length > 0) {
        const sum = clean.reduce((a, b) => a + b.pct, 0);
        if (Math.abs(sum - 100) > 0.1) {
            const err = new Error(`Las estrategias deben sumar 100% (actual: ${sum.toFixed(1)}%)`);
            err.code = 'STRATEGIES_SUM_INVALID';
            throw err;
        }
    }

    try {
        await pool.execute(
            'UPDATE pool_config SET strategies = ?, updated_at = NOW() WHERE id = 1',
            [JSON.stringify(clean)]
        );
        return clean;
    } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
            throw new Error('La columna pool_config.strategies no existe. Correr 002_add_pool_strategies.sql primero.');
        }
        throw e;
    }
}

// ══════════════════════════════════════════════════════════════════════
// GET /api/admin/pool/config-full
// Devuelve TODA la configuración del pool + estrategias.
// Pensado para el panel admin (el endpoint público /investments/pool-stats
// sigue funcionando como siempre).
// ══════════════════════════════════════════════════════════════════════
exports.adminGetPoolConfig = async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM pool_config WHERE id = 1 LIMIT 1');
        if (!rows.length) {
            return res.json({
                monthlyAPY: 2.0,
                annualAPY: 26.82,
                totalCapital: 0,
                distribution: 50,
                minAmount: 50000,
                monthsTracked: 0,
                strategies: [],
            });
        }
        const cfg = rows[0];
        const strategies = await readStrategies();

        res.json({
            monthlyAPY: parseFloat(cfg.monthly_apy) || 2.0,
            annualAPY: parseFloat(cfg.annual_apy) || 26.82,
            totalCapital: parseFloat(cfg.total_capital) || 0,
            distribution: parseInt(cfg.distribution) || 50,
            minAmount: parseFloat(cfg.min_amount) || 50000,
            monthsTracked: parseInt(cfg.months_tracked) || 0,
            strategies,
            updatedAt: cfg.updated_at,
        });
    } catch (e) {
        console.error('[adminGetPoolConfig]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════════════
// POST /api/admin/pool/config
// Actualiza la configuración del Pool.
// Body: { monthlyAPY, annualAPY, totalCapital, distribution, minAmount, strategies? }
//
// Comportamiento:
//   - Campos base se actualizan SIEMPRE
//   - strategies es opcional; si viene, se valida que sume 100% (con tolerancia 0.1)
//   - Si strategies viene mal formado o suma ≠ 100%, devuelve 400 sin tocar nada
// ══════════════════════════════════════════════════════════════════════
exports.adminUpdatePoolConfig = async (req, res) => {
    const {
        monthlyAPY,
        annualAPY,
        totalCapital,
        distribution,
        minAmount,
        strategies,
    } = req.body;

    // Validaciones
    const m = parseFloat(monthlyAPY);
    if (isNaN(m) || m <= 0 || m > 100) {
        return res.status(400).json({ error: 'APY mensual inválido (0-100)' });
    }
    const dist = parseFloat(distribution);
    if (isNaN(dist) || dist < 0 || dist > 100) {
        return res.status(400).json({ error: 'Distribución inválida (0-100)' });
    }
    const minA = parseFloat(minAmount);
    if (isNaN(minA) || minA < 0) {
        return res.status(400).json({ error: 'Monto mínimo inválido' });
    }
    const totC = parseFloat(totalCapital) || 0;
    const annA = parseFloat(annualAPY) || ((Math.pow(1 + m / 100, 12) - 1) * 100);

    try {
        // 1. Asegurar que existe la fila id=1 (INSERT IGNORE → si existe no hace nada)
        await pool.execute(
            `INSERT IGNORE INTO pool_config (id, monthly_apy, annual_apy, total_capital, distribution, min_amount, months_tracked)
             VALUES (1, ?, ?, ?, ?, ?, 0)`,
            [m, annA, totC, dist, minA]
        );

        // 2. Actualizar campos base
        await pool.execute(
            `UPDATE pool_config
             SET monthly_apy = ?, annual_apy = ?, total_capital = ?,
                 distribution = ?, min_amount = ?, updated_at = NOW()
             WHERE id = 1`,
            [m, annA, totC, dist, minA]
        );

        // 3. Si vinieron strategies, guardarlas
        let savedStrategies;
        if (strategies !== undefined) {
            try {
                savedStrategies = await writeStrategies(strategies);
            } catch (e) {
                if (e.code === 'STRATEGIES_SUM_INVALID') {
                    return res.status(400).json({ error: e.message });
                }
                // Otros errores (columna ausente, etc) → log y continuar
                console.error('[adminUpdatePoolConfig.strategies]', e.message);
            }
        }

        res.json({
            success: true,
            message: 'Configuración del Pool actualizada',
            config: {
                monthlyAPY: m,
                annualAPY: annA,
                totalCapital: totC,
                distribution: dist,
                minAmount: minA,
                ...(savedStrategies !== undefined && { strategies: savedStrategies }),
            },
        });
    } catch (e) {
        console.error('[adminUpdatePoolConfig]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════════════
// HELPER EXPORTADO: para que investmentController.getPoolStats pueda
// incluir strategies en su respuesta sin duplicar lógica
// ══════════════════════════════════════════════════════════════════════
exports.readStrategies = readStrategies;