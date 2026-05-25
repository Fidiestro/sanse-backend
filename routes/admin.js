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

// ══════════════════════════════════════════════════════════════
// GET /api/admin/users — Lista todos los usuarios (panel admin)
// Devuelve: id, full_name, email, phone, status, balance, totalInvested
// ══════════════════════════════════════════════════════════════
router.get('/users', async (req, res) => {
    const { pool: db } = require('../config/database');
    try {
        const [rows] = await db.execute(`
            SELECT
                u.id,
                u.full_name,
                u.email,
                u.phone,
                u.document_number,
                u.role,
                u.status,
                u.is_active,
                u.referral_code,
                u.referred_by,
                u.created_at,
                COALESCE(b.balance, 0) AS balance,
                COALESCE((
                    SELECT SUM(i.amount)
                    FROM investments i
                    WHERE i.user_id = u.id AND i.status = 'active'
                ), 0) AS totalInvested
            FROM users u
            LEFT JOIN (
                SELECT user_id, balance
                FROM user_balances
            ) b ON b.user_id = u.id
            WHERE u.role = 'client'
            ORDER BY u.created_at DESC
        `);
        res.json(rows);
    } catch (e) {
        console.error('[admin/users] Error:', e.message);
        // Fallback: si user_balances no existe, calcular balance desde transactions
        try {
            const [rows] = await db.execute(`
                SELECT
                    u.id,
                    u.full_name,
                    u.email,
                    u.phone,
                    u.document_number,
                    u.role,
                    u.status,
                    u.is_active,
                    u.referral_code,
                    u.referred_by,
                    u.created_at,
                    COALESCE((
                        SELECT SUM(
                            CASE
                                WHEN t.type IN ('deposit','payment','profit','investment_return') THEN t.amount
                                WHEN t.type IN ('withdrawal','investment') THEN -t.amount
                                ELSE 0
                            END
                        )
                        FROM transactions t
                        WHERE t.user_id = u.id
                    ), 0) AS balance,
                    COALESCE((
                        SELECT SUM(i.amount)
                        FROM investments i
                        WHERE i.user_id = u.id AND i.status = 'active'
                    ), 0) AS totalInvested
                FROM users u
                WHERE u.role = 'client'
                ORDER BY u.created_at DESC
            `);
            res.json(rows);
        } catch (e2) {
            console.error('[admin/users] Fallback también falló:', e2.message);
            res.status(500).json({ error: 'Error al obtener usuarios' });
        }
    }
});

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

// === GANANCIAS PRÉSTAMOS (ADMIN) — rutas específicas ANTES que /loans genérico ===
router.get('/loans/payments', loanController.adminGetLoanPayments);
router.get('/loans/profit-stats', loanController.adminGetLoanProfitStats);

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

// === REGISTRO CONTABLE POOL — comisiones 20% ===
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
        res.json([]); // Si la tabla no existe aún, devolver vacío
    }
});

// === SOLICITUDES DE REGISTRO (ADMIN) ===
const referralController = require('../controllers/referralController');
router.get('/registrations', referralController.adminGetRegistrations);
router.post('/registrations/:id/process', referralController.adminProcessRegistration);

module.exports = router;