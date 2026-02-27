const express = require('express');
const router = express.Router();
const investmentController = require('../controllers/investmentController');
const { authenticate } = require('../middleware/auth');

// Todas requieren autenticación
router.use(authenticate);

// Productos disponibles
router.get('/available', investmentController.getAvailableProducts);

// Resumen de balance (total, invertido, disponible)
router.get('/balance-summary', investmentController.getBalanceSummary);

// Mis inversiones
router.get('/my', investmentController.getMyInvestments);

// Detalle de una inversión
router.get('/:id', investmentController.getInvestmentDetail);

// Crear inversión SDTC desde balance
router.post('/create', investmentController.createUserInvestment);

module.exports = router;
