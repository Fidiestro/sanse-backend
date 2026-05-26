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
// FIX: Balance calculado FRESCO desde transactions usando los mismos
// INFLOW_TYPES / OUTFLOW_TYPES de balanceHelper (fuente única de verdad).
// Esto evita inconsistencias con user_balances/balance_history desactualizados.
// ══════════════════════════════════════════════════════════════
router.get('/users', async (req, res) => {
    const { pool: db } = require('../config/database');
    const { INFLOW_TYPES, OUTFLOW_TYPES } = require('../utils/balanceHelper');
    try {
        const inflowList  = INFLOW_TYPES.map(t => `'${t}'`).join(',');
        const outflowList = OUTFLOW_TYPES.map(t => `'${t}'`).join(',');

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
                GREATEST(0,
                    COALESCE((SELECT SUM(amount) FROM transactions
                              WHERE user_id = u.id AND type IN (${inflowList})), 0)
                    -
                    COALESCE((SELECT SUM(amount) FROM transactions
                              WHERE user_id = u.id AND type IN (${outflowList})), 0)
                ) AS balance,
                COALESCE((
                    SELECT SUM(i.amount) FROM investments i
                    WHERE i.user_id = u.id AND i.status = 'active'
                ), 0) AS totalInvested,
                COALESCE((
                    SELECT COUNT(*) FROM loan_requests lr
                    WHERE lr.user_id = u.id AND lr.status IN ('active','overdue')
                ), 0) AS activeLoansCount
            FROM users u
            WHERE u.role = 'client'
            ORDER BY u.created_at DESC
        `);
        res.json(rows);
    } catch (e) {
        console.error('[admin/users] Error:', e.message);
        res.status(500).json({ error: 'Error al obtener usuarios' });
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

// Detalles usuario — FIX: ahora incluye préstamos activos + balance fresco
router.get('/users/:id/details', async (req, res) => {
    const { pool: db } = require('../config/database');
    const { INFLOW_TYPES, OUTFLOW_TYPES } = require('../utils/balanceHelper');
    try {
        const userId = req.params.id;

        const [userRows] = await db.execute(
            `SELECT id, email, full_name, phone, document_number, role, status, is_active,
                    referral_code, referred_by, monthly_goal, created_at
             FROM users WHERE id = ?`, [userId]
        );
        if (!userRows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [investments]  = await db.execute(
            `SELECT * FROM investments WHERE user_id = ? ORDER BY start_date DESC`, [userId]
        );
        const [transactions] = await db.execute(
            `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`, [userId]
        );
        const [balanceHistory] = await db.execute(
            `SELECT amount, snapshot_date FROM balance_history
             WHERE user_id = ? ORDER BY snapshot_date ASC`, [userId]
        );

        // Préstamos del usuario (todos los estados)
        let loans = [];
        try {
            const [loanRows] = await db.execute(
                `SELECT id, ref_id, amount, approved_amount, monthly_rate, term_months,
                        start_date, due_date, status, admin_notes, created_at
                 FROM loan_requests WHERE user_id = ? ORDER BY created_at DESC`, [userId]
            );
            loans = loanRows;
        } catch (e) {
            console.warn('[users/:id/details] loan_requests no disponible:', e.message);
        }

        // Balance fresco calculado igual que /admin/users
        const inflowPH  = INFLOW_TYPES.map(() => '?').join(',');
        const outflowPH = OUTFLOW_TYPES.map(() => '?').join(',');
        const [inRows]  = await db.execute(
            `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
             WHERE user_id = ? AND type IN (${inflowPH})`, [userId, ...INFLOW_TYPES]
        );
        const [outRows] = await db.execute(
            `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
             WHERE user_id = ? AND type IN (${outflowPH})`, [userId, ...OUTFLOW_TYPES]
        );
        const freshBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));

        res.json({
            user: userRows[0],
            investments,
            transactions,
            balanceHistory,
            loans,
            freshBalance,
        });
    } catch (error) {
        console.error('[users/:id/details]', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

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

// ══════════════════════════════════════════════════════════════
// GET /api/admin/pool/strategies — Leer estrategias del pool
// POST /api/admin/pool/strategies — Guardar/actualizar estrategias
//
// Reemplaza el almacenamiento previo en localStorage del admin para
// que todos los admins compartan la misma vista y el usuario también
// pueda consultarlas vía /api/investments/pool-strategies.
// ══════════════════════════════════════════════════════════════
router.get('/pool/strategies', async (req, res) => {
    const { pool: db } = require('../config/database');
    try {
        const [rows] = await db.execute(
            `SELECT strategies FROM pool_config ORDER BY id ASC LIMIT 1`
        );
        if (!rows.length || rows[0].strategies === null) {
            return res.json([]);
        }
        // MySQL/MariaDB devuelve JSON ya parseado en algunas versiones, string en otras
        let strats = rows[0].strategies;
        if (typeof strats === 'string') {
            try { strats = JSON.parse(strats); } catch { strats = []; }
        }
        res.json(Array.isArray(strats) ? strats : []);
    } catch (e) {
        if (e && e.code === 'ER_BAD_FIELD_ERROR') {
            console.warn('[admin/pool/strategies] columna strategies no existe; correr 002_add_pool_strategies.sql');
            return res.json([]);
        }
        console.error('[admin/pool/strategies] GET error:', e.message);
        res.status(500).json({ error: 'Error al obtener estrategias' });
    }
});

router.post('/pool/strategies', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Solo administradores' });
    }
    const { pool: db } = require('../config/database');
    try {
        const { strategies } = req.body;
        if (!Array.isArray(strategies)) {
            return res.status(400).json({ error: 'strategies debe ser un array' });
        }
        const total = strategies.reduce((s, x) => s + (parseFloat(x.pct) || 0), 0);
        if (total !== 100) {
            return res.status(400).json({ error: `La suma de porcentajes debe ser 100% (actual: ${total}%)` });
        }
        for (const s of strategies) {
            if (!s.name || typeof s.name !== 'string') {
                return res.status(400).json({ error: 'Cada estrategia requiere un name' });
            }
            if (typeof s.pct !== 'number' || s.pct < 0 || s.pct > 100) {
                return res.status(400).json({ error: `pct inválido para "${s.name}"` });
            }
        }

        const [existing] = await db.execute(`SELECT id FROM pool_config ORDER BY id ASC LIMIT 1`);
        if (existing.length) {
            await db.execute(
                `UPDATE pool_config SET strategies = ? WHERE id = ?`,
                [JSON.stringify(strategies), existing[0].id]
            );
        } else {
            await db.execute(
                `INSERT INTO pool_config (strategies) VALUES (?)`,
                [JSON.stringify(strategies)]
            );
        }
        res.json({ message: 'Estrategias guardadas', strategies });
    } catch (e) {
        if (e && e.code === 'ER_BAD_FIELD_ERROR') {
            return res.status(503).json({
                error: 'La columna strategies no existe en pool_config. Correr migración 002_add_pool_strategies.sql primero.'
            });
        }
        console.error('[admin/pool/strategies] POST error:', e.message);
        res.status(500).json({ error: 'Error al guardar estrategias' });
    }
});

// ══════════════════════════════════════════════════════════════
// POST /api/admin/cleanup/admin-transactions
// Borra TODAS las transacciones cuyos user_id sean usuarios con role='admin'.
// Requiere body { confirm: true } para ejecutar; sin confirm hace dry-run.
// Solo el admin que llame puede ejecutar (req.user.role === 'admin').
// ══════════════════════════════════════════════════════════════
router.post('/cleanup/admin-transactions', async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Solo administradores pueden ejecutar esta acción' });
    }

    const { pool: db } = require('../config/database');
    const { recalculateAndSaveBalance } = require('../utils/balanceHelper');
    const confirm = req.body && req.body.confirm === true;

    const connection = await db.getConnection();
    try {
        // 1. Identificar admins
        const [admins] = await connection.execute(
            `SELECT id, email, full_name FROM users WHERE role = 'admin'`
        );
        if (!admins.length) {
            connection.release();
            return res.json({ dryRun: !confirm, message: 'No hay usuarios con role=admin', adminIds: [], txCount: 0 });
        }
        const adminIds = admins.map(a => a.id);
        const placeholders = adminIds.map(() => '?').join(',');

        // 2. Contar y listar transacciones afectadas (siempre, para reporte)
        const [txRows] = await connection.execute(
            `SELECT id, user_id, type, amount, description, ref_id, investment_id, loan_id, created_at
             FROM transactions
             WHERE user_id IN (${placeholders})
             ORDER BY created_at DESC`,
            adminIds
        );

        const summary = {
            adminIds,
            adminEmails: admins.map(a => a.email),
            txCount: txRows.length,
            totalAmount: txRows.reduce((s, t) => s + parseFloat(t.amount || 0), 0),
            byType: txRows.reduce((acc, t) => { acc[t.type] = (acc[t.type] || 0) + 1; return acc; }, {}),
            withInvestmentLink: txRows.filter(t => t.investment_id).length,
            withLoanLink: txRows.filter(t => t.loan_id).length,
        };

        // 3. DRY-RUN: sin confirm, devolver reporte y NO borrar nada
        if (!confirm) {
            connection.release();
            return res.json({
                dryRun: true,
                message: '⚠️  DRY-RUN. Nada fue borrado. Llama de nuevo con { "confirm": true } para ejecutar.',
                summary,
                sampleTransactions: txRows.slice(0, 20), // primeras 20 para inspección
            });
        }

        // 4. EJECUTAR borrado
        await connection.beginTransaction();
        const [delResult] = await connection.execute(
            `DELETE FROM transactions WHERE user_id IN (${placeholders})`,
            adminIds
        );

        // 5. Recalcular balance de cada admin (deja en 0 o coherente)
        const recalcResults = [];
        for (const adminId of adminIds) {
            try {
                const newBal = await recalculateAndSaveBalance(connection, adminId);
                recalcResults.push({ adminId, newBalance: newBal });
            } catch (e) {
                recalcResults.push({ adminId, error: e.message });
            }
        }

        await connection.commit();
        connection.release();

        console.log(`[cleanup/admin-transactions] Admin ${req.user.id} borró ${delResult.affectedRows} transacciones de admins`);

        return res.json({
            dryRun: false,
            message: `✅ Borradas ${delResult.affectedRows} transacciones de ${adminIds.length} admin(s)`,
            deletedCount: delResult.affectedRows,
            summary,
            recalcResults,
        });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        console.error('[cleanup/admin-transactions] Error:', error);
        res.status(500).json({ error: 'Error interno: ' + error.message });
    }
});

module.exports = router;