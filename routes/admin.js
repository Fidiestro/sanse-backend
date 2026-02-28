const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const withdrawalController = require('../controllers/withdrawalController');
const loanController = require('../controllers/loanController');
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

// Rendimientos SDTC
router.get('/investments/active', adminController.getActiveInvestments);
router.post('/investments/:investmentId/return', adminController.registerInvestmentReturn);

// Balance
router.post('/balance', adminController.recordBalance);
router.post('/recalculate-balance/:userId', adminController.recalculateBalance);
router.post('/recalculate-all-balances', adminController.recalculateAllBalances);

// Detalles usuario
router.get('/users/:id/details', adminController.getUserDetails);

// Bloquear/Desbloquear usuario
router.post('/users/:id/toggle-block', adminController.toggleBlockUser);

// Cancelar inversión (admin)
router.post('/investments/:id/cancel', adminController.adminCancelInvestment);

// === SOLICITUDES DE RETIRO (ADMIN) ===
router.get('/withdrawals', withdrawalController.adminGetWithdrawals);
router.post('/withdrawals/:id/process', withdrawalController.adminProcessWithdrawal);

// === SOLICITUDES DE PRÉSTAMO (ADMIN) ===
router.get('/loans', loanController.adminGetLoans);
router.post('/loans/:id/process', loanController.adminProcessLoan);
router.get('/users/:userId/credit-score', loanController.adminGetCreditScore);

module.exports = router;
