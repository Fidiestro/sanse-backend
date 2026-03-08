// ══════════════════════════════════════════════════════════════
// routes/withdrawals.js — Sanse Capital
// FIX: Nombres de métodos ahora coinciden con withdrawalController
// ══════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const withdrawalController = require('../controllers/withdrawalController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Métodos de pago (FIX: estos métodos ahora existen en el controller)
router.get('/payment-methods', withdrawalController.getPaymentMethods);
router.post('/payment-methods', withdrawalController.createPaymentMethod);
router.delete('/payment-methods/:id', withdrawalController.deletePaymentMethod);

// Solicitudes de retiro
// FIX: createWithdrawalRequest ahora es alias de requestWithdrawal
router.get('/my', withdrawalController.getMyWithdrawals);
router.post('/request', withdrawalController.createWithdrawalRequest);

module.exports = router;
