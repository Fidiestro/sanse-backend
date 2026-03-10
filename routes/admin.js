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
router.get('/transactions/all', adminController.getAllTransactions);
router.post('/transactions', adminController.createTransaction);
router.delete('/transactions/:id', adminController.deleteTransaction);

// Inversiones — rutas específicas ANTES que las parametrizadas
router.get('/investments/active', adminController.getActiveInvestments);
router.post('/investments', adminController.createInvestment);
router.post('/investments/:investmentId/return', adminController.registerInvestmentReturn);
router.post('/investments/:id/cancel', adminController.adminCancelInvestment);
router.delete('/investments/:id', adminController.deleteInvestment);

// Balance
router.post('/balance', adminController.recordBalance);
router.post('/recalculate-balance/:userId', adminController.recalculateBalance);
router.post('/recalculate-all-balances', adminController.recalculateAllBalances);

// Detalles usuario
router.get('/users/:id/details', adminController.getUserDetails);

// Bloquear/Desbloquear usuario
router.post('/users/:id/toggle-block', adminController.toggleBlockUser);

// Editar usuario (datos + contraseña + referido)
router.post('/users/:id/edit', adminController.editUser);

// Crear préstamo directo para un usuario
router.post('/loans/create', adminController.adminCreateLoan);


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

// === SOLICITUDES DE REGISTRO (ADMIN) ===
const referralController = require('../controllers/referralController');
router.get('/registrations', referralController.adminGetRegistrations);
router.post('/registrations/:id/process', referralController.adminProcessRegistration);

module.exports = router;