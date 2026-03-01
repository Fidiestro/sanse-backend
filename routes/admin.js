const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const withdrawalController = require('../controllers/withdrawalController');
const loanController = require('../controllers/loanController');
const depositController = require('../controllers/depositController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Middleware: admin O p2p pueden acceder
const requireAdminOrP2P = (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.role !== 'p2p') {
        return res.status(403).json({ error: 'Acceso denegado.' });
    }
    next();
};

// Todas las rutas requieren autenticación + admin
router.use(authenticate, requireAdminOrP2P);

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

// === SOLICITUDES DE DEPÓSITO (ADMIN + P2P) ===
router.get('/deposits', depositController.adminGetDeposits);
router.post('/deposits/:id/process', depositController.adminProcessDeposit);

module.exports = router;
