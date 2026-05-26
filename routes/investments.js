const express = require('express');
const router = express.Router();
const investmentController = require('../controllers/investmentController');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');

// Todas requieren autenticación
router.use(authenticate);

// ── Rutas GET sin parámetro (van PRIMERO) ──────────────────
router.get('/available',       investmentController.getAvailableProducts);
router.get('/balance-summary', investmentController.getBalanceSummary);
router.get('/global-stats',    investmentController.getGlobalStats);
router.get('/my',              investmentController.getMyInvestments);
router.get('/pool-stats',      investmentController.getPoolStats);

// ── NUEVO: estrategias del pool (lectura para usuarios) ────
// El admin las edita vía /api/admin/pool/strategies
router.get('/pool-strategies', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT strategies FROM pool_config ORDER BY id ASC LIMIT 1`
        );
        if (!rows.length || rows[0].strategies === null) return res.json([]);
        let strats = rows[0].strategies;
        if (typeof strats === 'string') {
            try { strats = JSON.parse(strats); } catch { strats = []; }
        }
        res.json(Array.isArray(strats) ? strats : []);
    } catch (e) {
        if (e && e.code === 'ER_BAD_FIELD_ERROR') {
            // Sin migración aplicada — no romper el dashboard
            return res.json([]);
        }
        console.error('[investments/pool-strategies]', e.message);
        res.json([]);
    }
});

// ── Rutas POST sin parámetro (van ANTES de /:id) ───────────
router.post('/create',         investmentController.createUserInvestment);

// ── Rutas con parámetro /:id ───────────────────────────────
router.get( '/:id',                  investmentController.getInvestmentDetail);
router.post('/:id/add-capital',      investmentController.addCapitalToInvestment);
router.post('/:id/cancel',           investmentController.cancelInvestment);
router.post('/:id/confirm',          investmentController.confirmInvestment);
router.post('/:id/withdraw',         investmentController.withdrawInvestment);
router.post('/:id/withdraw-earnings',investmentController.withdrawPoolEarnings);

module.exports = router;
//xd