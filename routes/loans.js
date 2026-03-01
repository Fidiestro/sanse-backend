const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Mis préstamos
router.get('/my', loanController.getMyLoans);

// Mi puntaje crediticio
router.get('/credit-score', loanController.getCreditScore);

// Solicitar préstamo
router.post('/request', loanController.requestLoan);

// Abonar a préstamo
router.post('/pay', loanController.payLoan);

module.exports = router;