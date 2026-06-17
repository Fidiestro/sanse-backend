const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const withdrawalController = require('../controllers/withdrawalController');
const loanController = require('../controllers/loanController');
const depositController = require('../controllers/depositController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const supportController = require('../controllers/supportController');
const poolRewardsController = require('../controllers/poolRewardsController');

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
                ), 0) AS activeLoansCount,
                -- Ahorros = depósitos
                COALESCE((SELECT SUM(amount) FROM transactions
                          WHERE user_id = u.id AND type = 'deposit'), 0) AS ahorros,
                -- Retirado = retiros
                COALESCE((SELECT SUM(ABS(amount)) FROM transactions
                          WHERE user_id = u.id AND type = 'withdraw'), 0) AS totalWithdrawn,
                -- Préstamos = capital pendiente de préstamos activos/mora
                COALESCE((SELECT SUM(COALESCE(lr.approved_amount, lr.amount))
                          FROM loan_requests lr
                          WHERE lr.user_id = u.id AND lr.status IN ('active','overdue')), 0) AS prestamos,
                -- Ganancias = rendimientos/ganancias pagadas al usuario
                COALESCE((SELECT SUM(amount) FROM transactions
                          WHERE user_id = u.id AND type IN ('profit','interest','investment_return')), 0) AS ganancias
            FROM users u
            WHERE u.role = 'client'
            ORDER BY u.created_at DESC
        `);

        // Intereses cobrados (acumulado teórico) por préstamos activos:
        // interés mensual × meses transcurridos desde start_date.
        let loanMap = {};
        try {
            const [loanRows] = await db.execute(
                `SELECT user_id, COALESCE(approved_amount, amount) AS capital,
                        COALESCE(approved_rate, monthly_rate, 0) AS rate, start_date, status
                 FROM loan_requests WHERE status IN ('active','overdue')`
            );
            const now = new Date();
            loanRows.forEach(l => {
                let months = 0;
                if (l.start_date) {
                    const start = new Date(l.start_date);
                    if (!isNaN(start)) months = Math.floor(Math.max(0, (now - start) / (1000*60*60*24)) / 30);
                }
                const interest = Math.round(parseFloat(l.capital || 0) * (parseFloat(l.rate || 0) / 100) * months);
                loanMap[l.user_id] = (loanMap[l.user_id] || 0) + interest;
            });
        } catch (e) {
            console.warn('[admin/users] intereses préstamos:', e.message);
        }

        const out = rows.map(u => {
            const balance   = parseFloat(u.balance || 0);
            const prestamos = parseFloat(u.prestamos || 0);
            const intereses = loanMap[u.id] || 0;
            // Estado: Activo si tiene préstamo activo o saldo positivo; Inactivo si no
            const estado = (prestamos > 0 || balance > 0) ? 'active' : 'inactive';
            return {
                ...u,
                balance,
                ahorros: parseFloat(u.ahorros || 0),
                totalWithdrawn: parseFloat(u.totalWithdrawn || 0),
                prestamos,
                ganancias: parseFloat(u.ganancias || 0),
                intereses,
                estado,
            };
        });

        res.json(out);
    } catch (e) {
        console.error('[admin/users] Error:', e.message);
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/admin/global-summary — Resumen tipo "caja" (tu hoja)
// Total Ahorros, Total Préstamos, Total Intereses Cobrados,
// Total Ganancias Pagadas, Total Retiros, Balance en CAJA,
// Dinero fondo recolectado.
// ══════════════════════════════════════════════════════════════
router.get('/global-summary', async (req, res) => {
    const { pool: db } = require('../config/database');
    try {
        const sum1 = async (sql, params = []) => {
            const [r] = await db.execute(sql, params);
            return parseFloat(r[0].t || 0);
        };

        // Solo clientes (no admin/p2p)
        const totalAhorros = await sum1(
            `SELECT COALESCE(SUM(t.amount),0) AS t FROM transactions t
             JOIN users u ON u.id = t.user_id
             WHERE u.role = 'client' AND t.type = 'deposit'`
        );
        const totalPrestamos = await sum1(
            `SELECT COALESCE(SUM(COALESCE(lr.approved_amount, lr.amount)),0) AS t
             FROM loan_requests lr JOIN users u ON u.id = lr.user_id
             WHERE u.role = 'client' AND lr.status IN ('active','overdue')`
        );
        const totalGanancias = await sum1(
            `SELECT COALESCE(SUM(t.amount),0) AS t FROM transactions t
             JOIN users u ON u.id = t.user_id
             WHERE u.role = 'client' AND t.type IN ('profit','interest','investment_return')`
        );
        const totalRetiros = await sum1(
            `SELECT COALESCE(SUM(ABS(t.amount)),0) AS t FROM transactions t
             JOIN users u ON u.id = t.user_id
             WHERE u.role = 'client' AND t.type = 'withdraw'`
        );
        // Pagos recibidos (abonos a préstamos)
        const totalAbonos = await sum1(
            `SELECT COALESCE(SUM(t.amount),0) AS t FROM transactions t
             JOIN users u ON u.id = t.user_id
             WHERE u.role = 'client' AND t.type = 'payment'`
        );

        // Total Intereses Cobrados = acumulado teórico de préstamos activos
        let totalIntereses = 0;
        try {
            const [loanRows] = await db.execute(
                `SELECT COALESCE(lr.approved_amount, lr.amount) AS capital,
                        COALESCE(lr.approved_rate, lr.monthly_rate, 0) AS rate, lr.start_date
                 FROM loan_requests lr JOIN users u ON u.id = lr.user_id
                 WHERE u.role = 'client' AND lr.status IN ('active','overdue')`
            );
            const now = new Date();
            loanRows.forEach(l => {
                let months = 0;
                if (l.start_date) {
                    const start = new Date(l.start_date);
                    if (!isNaN(start)) months = Math.floor(Math.max(0, (now - start) / (1000*60*60*24)) / 30);
                }
                totalIntereses += Math.round(parseFloat(l.capital || 0) * (parseFloat(l.rate || 0) / 100) * months);
            });
        } catch (e) {
            console.warn('[global-summary] intereses:', e.message);
        }

        // Dinero fondo recolectado = capital activo en Fondo DGP (Pool)
        const dineroFondo = await sum1(
            `SELECT COALESCE(SUM(i.amount),0) AS t FROM investments i
             JOIN users u ON u.id = i.user_id
             WHERE u.role = 'client' AND LOWER(i.type) LIKE '%pool%' AND i.status = 'active'`
        );

        // Balance en CAJA = Ahorros − Préstamos activos (tu fila naranja)
        const balanceCaja = totalAhorros - totalPrestamos;

        res.json({
            totalAhorros,
            totalPrestamos,
            totalIntereses,
            totalGanancias,
            totalRetiros,
            totalAbonos,
            balanceCaja,
            dineroFondo,
        });
    } catch (e) {
        console.error('[admin/global-summary] Error:', e.message);
        res.status(500).json({ error: 'Error al calcular el resumen global' });
    }
});

// Stats
router.get('/stats', adminController.getStats);

// Transacciones
router.get('/transactions/recent', adminController.getRecentTransactions);
router.get('/transactions/all', adminController.getAllTransactions);
router.post('/transactions', adminController.createTransaction);
router.delete('/transactions/:id', adminController.deleteTransaction);
router.put('/transactions/:id', adminController.editTransaction);

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

        let [investments]  = await db.execute(
            `SELECT * FROM investments WHERE user_id = ? ORDER BY start_date DESC`, [userId]
        );

        // Acumulado SIN reclamar por inversión (investment_returns.status = 'accrued')
        // Una sola query agrupada por investment_id para no consultar N veces.
        try {
            const [accRows] = await db.execute(
                `SELECT ir.investment_id, COALESCE(SUM(ir.amount_earned),0) AS pending
                 FROM investment_returns ir
                 JOIN investments i ON i.id = ir.investment_id
                 WHERE i.user_id = ? AND ir.status = 'accrued'
                 GROUP BY ir.investment_id`, [userId]
            );
            const accMap = {};
            accRows.forEach(a => { accMap[a.investment_id] = parseFloat(a.pending || 0); });
            investments = investments.map(inv => ({
                ...inv,
                accruedPending: accMap[inv.id] || 0,
            }));
        } catch (e) {
            console.warn('[users/:id/details] accruedPending por inversión:', e.message);
        }

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
                `SELECT id, ref_id, amount, approved_amount, monthly_rate, approved_rate, term_months,
                        start_date, due_date, status, admin_notes, created_at
                 FROM loan_requests WHERE user_id = ? ORDER BY created_at DESC`, [userId]
            );
            loans = loanRows;
        } catch (e) {
            console.warn('[users/:id/details] loan_requests no disponible:', e.message);
        }

        // Intereses acumulados por préstamo = interés mensual × meses transcurridos desde start_date
        const _now = new Date();
        loans = loans.map(l => {
            const capital = (l.approved_amount !== null && l.approved_amount !== undefined)
                ? parseFloat(l.approved_amount)
                : parseFloat(l.amount || 0);
            const rate = parseFloat(l.approved_rate || l.monthly_rate || 0);
            let monthsElapsed = 0;
            let accruedInterest = 0;
            if ((l.status === 'active' || l.status === 'overdue') && l.start_date) {
                const start = new Date(l.start_date);
                if (!isNaN(start)) {
                    const days = Math.max(0, (_now - start) / (1000 * 60 * 60 * 24));
                    monthsElapsed = Math.floor(days / 30);
                    accruedInterest = Math.round(capital * (rate / 100) * monthsElapsed);
                }
            }
            return { ...l, monthsElapsed, accruedInterest };
        });

        // Depósitos con comprobante (deposit_requests)
        let deposits = [];
        try {
            const [depRows] = await db.execute(
                `SELECT id, amount, note, status, ref_id, proof_image, created_at
                 FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC`, [userId]
            );
            deposits = depRows;
        } catch (e) {
            console.warn('[users/:id/details] deposit_requests no disponible:', e.message);
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

        // ── RESUMEN FINANCIERO (mapea la hoja de Excel) ──
        const sumType = async (types) => {
            const ph = types.map(() => '?').join(',');
            const [r] = await db.execute(
                `SELECT COALESCE(SUM(ABS(amount)),0) AS t FROM transactions
                 WHERE user_id = ? AND type IN (${ph})`, [userId, ...types]
            );
            return parseFloat(r[0].t);
        };
        // Total Ahorros = depósitos
        const totalDeposited = await sumType(['deposit']);
        // Retiros Entregados = retiros
        const totalWithdrawn = await sumType(['withdraw']);
        // Total Préstamos Otorgados = transacciones tipo loan
        const totalLoansGiven = await sumType(['loan']);
        // Pagos recibidos (abonos a préstamos)
        const totalLoanPayments = await sumType(['payment']);
        // Ganancias Realizadas = rendimientos/intereses/ganancias pagadas al usuario
        const totalEarningsPaid = await sumType(['profit', 'interest', 'investment_return']);

        // Préstamos Activos = capital pendiente de préstamos activos/mora
        const activeLoans = loans.filter(l => l.status === 'active' || l.status === 'overdue');
        const activeLoanCapital = activeLoans.reduce(
            (s, l) => s + parseFloat(l.approved_amount != null ? l.approved_amount : (l.amount || 0)), 0
        );
        // Intereses cobrados acumulados (teórico) de préstamos activos
        const totalLoanInterestAccrued = activeLoans.reduce((s, l) => s + parseFloat(l.accruedInterest || 0), 0);

        // ¿Cliente en inversión? (tasa 4% si tiene inversión activa, 6% si no — como en tu hoja)
        const hasActiveInvestment = investments.some(i => i.status === 'active');

        // Ganancias SIN retirar — LP COP (CDTC) acumuladas no reclamadas
        let unclaimedLP = 0;
        try {
            const [lp] = await db.execute(
                `SELECT COALESCE(SUM(ir.amount_earned),0) AS t
                 FROM investment_returns ir
                 JOIN investments i ON ir.investment_id = i.id
                 WHERE i.user_id = ? AND ir.status = 'accrued'
                   AND (i.type IS NULL OR LOWER(i.type) NOT LIKE '%pool%')`, [userId]
            );
            unclaimedLP = parseFloat(lp[0].t);
        } catch (e) { console.warn('[users/:id/details] unclaimedLP:', e.message); }

        // Ganancias SIN retirar — Fondo DGP (Pool) retirable
        let unclaimedPool = 0;
        try {
            const [pl] = await db.execute(
                `SELECT COALESCE(SUM(withdrawable_earnings),0) AS t
                 FROM investments
                 WHERE user_id = ? AND LOWER(type) LIKE '%pool%' AND status = 'active'`, [userId]
            );
            unclaimedPool = parseFloat(pl[0].t);
        } catch (e) { console.warn('[users/:id/details] unclaimedPool:', e.message); }

        res.json({
            user: userRows[0],
            investments,
            transactions,
            balanceHistory,
            loans,
            deposits,
            freshBalance,
            summary: {
                hasActiveInvestment,
                interestRate: hasActiveInvestment ? 4.0 : 6.0,
                totalDeposited,
                totalWithdrawn,
                totalLoansGiven,
                totalLoanPayments,
                totalEarningsPaid,
                activeLoanCapital,
                totalLoanInterestAccrued,
                unclaimedLP,
                unclaimedPool,
            },
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
// RECOMPENSA MASIVA — LP COP (nuevas) y Pool (respaldo)
// LP COP: acumula en investment_returns con status='accrued'
// Pool: acumula en withdrawable_earnings (mecanismo existente)
// ══════════════════════════════════════════════════════════════
router.get('/lp/reward-preview', poolRewardsController.previewBulkRewardLP);
router.post('/lp/pay-returns-bulk', poolRewardsController.applyBulkRewardLP);

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
// SOPORTE (CHAT DE AYUDA) — ADMIN
// ★ FIX: Las rutas estaban faltando. El supportController ya existía
// pero nunca se exponían sus métodos admin, devolviendo 404 cada 3-5s.
//
// Frontend admin.html llama:
//   GET  /api/admin/support/unread-count              (badge de no leídos)
//   GET  /api/admin/support/chats?status=open|closed  (lista chats)
//   GET  /api/admin/support/chats/:id/messages?since=N (polling de mensajes)
//   POST /api/admin/support/chats/:id/message         (responder)
//   POST /api/admin/support/chats/:id/close           (cerrar chat)
//
// NOTA: /support/unread-count va PRIMERO para que no entre por el
// matcher de /support/chats/:id/... (aunque Express no los confunde
// porque tienen prefijos distintos, mantener orden por convención).
// ══════════════════════════════════════════════════════════════
router.get( '/support/unread-count',        supportController.adminUnreadCount);
router.get( '/support/chats',               supportController.adminListChats);
router.get( '/support/chats/:id/messages',  supportController.adminGetMessages);
router.post('/support/chats/:id/message',   supportController.adminSendMessage);
router.post('/support/chats/:id/close',     supportController.adminCloseChat);

// ══════════════════════════════════════════════════════════════
// CADENAS DE AHORRO — Admin
// ══════════════════════════════════════════════════════════════
const cadenasController = require('../controllers/cadenasController');
router.get( '/cadenas',                    cadenasController.adminList);
router.post('/cadenas',                    cadenasController.adminCreate);
router.get( '/cadenas/:id',                cadenasController.adminGet);
router.post('/cadenas/:id/start',          cadenasController.adminStart);
router.post('/cadenas/:id/mark-paid',      cadenasController.adminMarkPaid);
router.post('/cadenas/:id/deliver',        cadenasController.adminDeliverPayout);
router.post('/cadenas/:id/cancel',         cadenasController.adminCancel);
router.post('/cadenas/:id/remove-member',  cadenasController.adminRemoveMember);

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