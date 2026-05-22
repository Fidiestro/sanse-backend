// ══════════════════════════════════════════════════════════════
// routes/admin.js — Sanse Capital
// CAMBIOS RESPECTO A LA VERSIÓN ANTERIOR:
//  1. Nueva: GET  /admin/users               → listAllUsers
//  2. Nueva: POST /admin/users/create        → createUserByAdmin
//  3. Nueva: POST /admin/pool/config         → savePoolConfig
//  4. Eliminado el GET /pool/withdrawals DUPLICADO (estaba 2 veces)
//
//  ✱ Compatibilidad: además del endpoint correcto POST /users/:id/toggle-block,
//    se mantiene un alias POST /users/:id/block que admin.html llamaba antes.
//    Así el frontend sigue funcionando sin cambios bruscos.
// ══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const adminController       = require('../controllers/adminController');
const withdrawalController  = require('../controllers/withdrawalController');
const loanController        = require('../controllers/loanController');
const depositController     = require('../controllers/depositController');
const referralController    = require('../controllers/referralController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Middleware: admin O p2p pueden acceder
const requireAdminOrP2P = (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.role !== 'p2p') {
        return res.status(403).json({ error: 'Acceso denegado.' });
    }
    next();
};

// Todas las rutas requieren autenticación + admin/p2p
router.use(authenticate, requireAdminOrP2P);

// ── Stats ─────────────────────────────────────────────────────
router.get('/stats', adminController.getStats);

// ── Transacciones ─────────────────────────────────────────────
router.get('/transactions/recent', adminController.getRecentTransactions);
router.get('/transactions/all',    adminController.getAllTransactions);
router.post('/transactions',       adminController.createTransaction);
router.delete('/transactions/:id', adminController.deleteTransaction);

// ── Inversiones (rutas específicas ANTES que las parametrizadas) ─
router.get('/investments/active',                     adminController.getActiveInvestments);
router.post('/investments',                           adminController.createInvestment);
router.post('/investments/:investmentId/return',      adminController.registerInvestmentReturn);
router.post('/investments/:id/cancel',                adminController.adminCancelInvestment);
router.delete('/investments/:id',                     adminController.deleteInvestment);

// ── Balance ───────────────────────────────────────────────────
router.post('/balance',                          adminController.recordBalance);
router.post('/recalculate-balance/:userId',      adminController.recalculateBalance);
router.post('/recalculate-all-balances',         adminController.recalculateAllBalances);

// ── USUARIOS ──────────────────────────────────────────────────
// NUEVO: lista global de usuarios (necesario para el frontend admin)
router.get('/users',                  adminController.listAllUsers);
// NUEVO: crear usuario desde el admin
router.post('/users/create',          adminController.createUserByAdmin);
// Detalles de un usuario
router.get('/users/:id/details',      adminController.getUserDetails);
// Bloquear/desbloquear (endpoint canónico)
router.post('/users/:id/toggle-block', adminController.toggleBlockUser);
// Alias retro-compatible para frontend antiguo (POST /users/:id/block)
router.post('/users/:id/block',        adminController.toggleBlockUser);
// Editar usuario
router.post('/users/:id/edit',         adminController.editUser);

// ── Préstamos ─────────────────────────────────────────────────
// Específicas ANTES que /:id/process
router.get('/loans/payments',                loanController.adminGetLoanPayments);
router.get('/loans/profit-stats',            loanController.adminGetLoanProfitStats);
router.post('/loans/create',                 adminController.adminCreateLoan);
router.get('/loans',                         loanController.adminGetLoans);
router.post('/loans/:id/process',            loanController.adminProcessLoan);
router.get('/users/:userId/credit-score',    loanController.adminGetCreditScore);

// ── Retiros ───────────────────────────────────────────────────
router.get('/withdrawals',              withdrawalController.adminGetWithdrawals);
router.post('/withdrawals/:id/process', withdrawalController.adminProcessWithdrawal);

// ── Depósitos ─────────────────────────────────────────────────
router.get('/deposits',                 depositController.adminGetDeposits);
router.post('/deposits/:id/process',    depositController.adminProcessDeposit);

// ── POOL ──────────────────────────────────────────────────────
// NUEVO: guardar configuración del pool (antes vivía en archivo huérfano)
router.post('/pool/config', adminController.savePoolConfig);

// Registro contable de retiros del pool (comisiones 20%)
router.get('/pool/withdrawals', async (req, res) => {
    const { pool: db } = require('../config/database');
    try {
        const [rows] = await db.execute(
            `SELECT pw.*, u.full_name as user_name, u.email as user_email
             FROM pool_withdrawals pw
             JOIN users u ON pw.user_id = u.id
             ORDER BY pw.withdrawal_date DESC, pw.id DESC
             LIMIT 200`
        );
        res.json(rows);
    } catch (e) {
        console.error('[admin/pool/withdrawals]', e);
        res.json([]); // Si la tabla aún no existe, devolver vacío en lugar de 500
    }
});

// ── Solicitudes de Registro ───────────────────────────────────
router.get('/registrations',                 referralController.adminGetRegistrations);
router.post('/registrations/:id/process',    referralController.adminProcessRegistration);

module.exports = router;