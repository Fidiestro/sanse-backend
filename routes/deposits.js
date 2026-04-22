const express = require('express');
const router = express.Router();
const depositController = require('../controllers/depositController');
const { authenticate } = require('../middleware/auth');

// Todas las rutas requieren autenticación
router.use(authenticate);

// POST /api/deposits/create → registra nuevo depósito pendiente + notifica Telegram
router.post('/create', depositController.create);

// GET /api/deposits/my → lista depósitos del usuario autenticado
router.get('/my', depositController.myDeposits);

module.exports = router;