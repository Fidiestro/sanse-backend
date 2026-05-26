const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');

router.use(authenticate);

// Mis préstamos
router.get('/my', loanController.getMyLoans);

// Mi puntaje crediticio
router.get('/credit-score', loanController.getCreditScore);

// Solicitar préstamo
router.post('/request', loanController.requestLoan);

// Abonar a préstamo
router.post('/pay', loanController.payLoan);

// ══════════════════════════════════════════════════════════════
// GET /api/loans/:loanId/payments — Historial de pagos de UN préstamo
// Solo el dueño del préstamo puede ver sus pagos.
// ══════════════════════════════════════════════════════════════
router.get('/:loanId/payments', async (req, res) => {
    try {
        const userId = req.user.id;
        const loanId = req.params.loanId;

        // Verificar que el préstamo pertenece al usuario
        const [loanCheck] = await pool.execute(
            `SELECT id FROM loan_requests WHERE id = ? AND user_id = ?`,
            [loanId, userId]
        );
        if (!loanCheck.length) {
            return res.status(404).json({ error: 'Préstamo no encontrado' });
        }

        // Traer pagos
        const [payments] = await pool.execute(
            `SELECT id, amount, interest_amount, capital_amount, remaining_capital,
                    loan_rate, ref_id, is_fully_paid, created_at
             FROM loan_payments
             WHERE loan_id = ? AND user_id = ?
             ORDER BY created_at DESC`,
            [loanId, userId]
        );

        res.json(payments);
    } catch (error) {
        console.error('Error obteniendo pagos del préstamo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/loans/payments/all — Historial completo de TODOS los pagos del usuario
// Útil para mostrar "Últimos pagos" agregado en el dashboard
// ══════════════════════════════════════════════════════════════
router.get('/payments/all', async (req, res) => {
    try {
        const userId = req.user.id;
        const [payments] = await pool.execute(
            `SELECT lp.id, lp.loan_id, lp.amount, lp.interest_amount, lp.capital_amount,
                    lp.remaining_capital, lp.loan_rate, lp.ref_id, lp.is_fully_paid, lp.created_at,
                    lr.ref_id AS loan_ref_id
             FROM loan_payments lp
             LEFT JOIN loan_requests lr ON lp.loan_id = lr.id
             WHERE lp.user_id = ?
             ORDER BY lp.created_at DESC
             LIMIT 100`,
            [userId]
        );
        res.json(payments);
    } catch (error) {
        console.error('Error obteniendo todos los pagos del usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

module.exports = router;