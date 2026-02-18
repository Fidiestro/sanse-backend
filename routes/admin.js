const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Todas las rutas requieren autenticación + rol admin
router.use(authenticate, requireAdmin);

// Inversiones
router.post('/investments', adminController.createInvestment);
router.delete('/investments/:id', adminController.deleteInvestment);

// Transacciones
router.post('/transactions', adminController.createTransaction);
router.delete('/transactions/:id', adminController.deleteTransaction);

// Balance
router.post('/balance', adminController.recordBalance);

// Detalles de usuario
router.get('/users/:id/details', adminController.getUserDetails);

module.exports = router;
