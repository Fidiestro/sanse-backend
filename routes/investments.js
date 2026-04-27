const express = require('express');
const router = express.Router();
const investmentController = require('../controllers/investmentController');
const { authenticate } = require('../middleware/auth');

// Todas requieren autenticación
router.use(authenticate);

// ── Rutas GET sin parámetro (van PRIMERO) ──────────────────
router.get('/available',       investmentController.getAvailableProducts);
router.get('/balance-summary', investmentController.getBalanceSummary);
router.get('/global-stats',    investmentController.getGlobalStats);
router.get('/my',              investmentController.getMyInvestments);
router.get('/pool-stats',      investmentController.getPoolStats);

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