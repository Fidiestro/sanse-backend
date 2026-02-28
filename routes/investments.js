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

// Estadísticas globales SDTC (total bloqueado, APY)
router.get('/global-stats', investmentController.getGlobalStats);

// Mis inversiones
router.get('/my', investmentController.getMyInvestments);

// Detalle de una inversión
router.get('/:id', investmentController.getInvestmentDetail);

// Crear inversión SDTC desde balance
router.post('/create', investmentController.createUserInvestment);

// Agregar capital a una inversión existente (sin cambiar fecha de vencimiento)
router.post('/:id/add-capital', investmentController.addCapitalToInvestment);

// Cancelar inversión en período de depósito (12h)
router.post('/:id/cancel', investmentController.cancelInvestment);

// Confirmar inversión (activar inmediatamente)
router.post('/:id/confirm', investmentController.confirmInvestment);

// Retirar inversión vencida (devuelve capital al disponible)
router.post('/:id/withdraw', investmentController.withdrawInvestment);

module.exports = router;
