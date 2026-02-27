const express = require('express');
const router = express.Router();
const withdrawalController = require('../controllers/withdrawalController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Métodos de pago
router.get('/payment-methods', withdrawalController.getPaymentMethods);
router.post('/payment-methods', withdrawalController.createPaymentMethod);
router.delete('/payment-methods/:id', withdrawalController.deletePaymentMethod);

// Solicitudes de retiro
router.get('/my', withdrawalController.getMyWithdrawals);
router.post('/request', withdrawalController.createWithdrawalRequest);

module.exports = router;
