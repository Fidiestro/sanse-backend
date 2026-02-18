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

// Balance
router.post('/balance', adminController.recordBalance);

// Detalles usuario
router.get('/users/:id/details', adminController.getUserDetails);

module.exports = router;
