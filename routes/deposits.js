const express = require('express');
const router = express.Router();
const depositController = require('../controllers/depositController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Mis depósitos
router.get('/my', depositController.getMyDeposits);

// Solicitar depósito (con comprobante)
router.post('/request', depositController.requestDeposit);

module.exports = router;
