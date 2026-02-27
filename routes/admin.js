const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticación + admin
router.use(authenticate, requireAdmin);

// Stats
router.get('/stats', adminController.getStats);

// Transacciones
router.get('/transactions/recent', adminController.getRecentTransactions);
router.post('/transactions', adminController.createTransaction);
router.delete('/transactions/:id', adminController.deleteTransaction);

// Inversiones
router.post('/investments', adminController.createInvestment);
router.delete('/investments/:id', adminController.deleteInvestment);

// === NUEVAS RUTAS PARA RENDIMIENTOS SDTC ===
// Listar inversiones activas (para el selector en admin)
router.get('/investments/active', adminController.getActiveInvestments);
// Registrar rendimiento mensual a una inversión
router.post('/investments/:investmentId/return', adminController.registerInvestmentReturn);

// Balance
router.post('/balance', adminController.recordBalance);
router.post('/recalculate-balance/:userId', adminController.recalculateBalance);
router.post('/recalculate-all-balances', adminController.recalculateAllBalances);

// Detalles usuario
router.get('/users/:id/details', adminController.getUserDetails);

module.exports = router;
