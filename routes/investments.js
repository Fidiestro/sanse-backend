const express = require('express');
const router = express.Router();
const investmentController = require('../controllers/investmentController');
const { authenticate } = require('../middleware/auth');

// ── Carga DEFENSIVA de lpController ─────────────────────────
// Si el archivo no existe o no exporta los métodos, NO tumbamos
// el módulo completo de inversiones: solo se desactivan las
// rutas /lp/* y el resto funciona normal.
let lpController = null;
try {
    lpController = require('../controllers/lpController');
    if (typeof lpController.getAccruedSummary !== 'function' ||
        typeof lpController.claimAccrued !== 'function') {
        console.error('⚠️ lpController existe pero le faltan métodos (getAccruedSummary/claimAccrued). Rutas /lp/* desactivadas.');
        lpController = null;
    }
} catch (e) {
    console.error('⚠️ lpController no disponible:', e.message, '— Rutas /lp/* desactivadas.');
}

const lpNotAvailable = (req, res) =>
    res.status(501).json({ error: 'Módulo LP no disponible en este deploy.' });

// Todas requieren autenticación
router.use(authenticate);

// ── Rutas GET sin parámetro (van PRIMERO) ──────────────────
router.get('/available',       investmentController.getAvailableProducts);
router.get('/balance-summary', investmentController.getBalanceSummary);
router.get('/global-stats',    investmentController.getGlobalStats);
router.get('/my',              investmentController.getMyInvestments);
router.get('/pool-stats',      investmentController.getPoolStats);

// ── LP COP — pagos automáticos (DEBEN ir ANTES de /:id) ────
router.get('/lp/accrued', lpController ? lpController.getAccruedSummary : lpNotAvailable);
router.post('/lp/claim',  lpController ? lpController.claimAccrued     : lpNotAvailable);

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