const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

// Todas las rutas requieren autenticación
router.get('/summary', authenticate, dashboardController.getSummary);

module.exports = router;
