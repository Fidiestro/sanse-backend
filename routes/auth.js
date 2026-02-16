const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimit');

// Públicas
router.post('/login', loginLimiter, authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/setup', authController.setup);

// Autenticadas
router.get('/profile', authenticate, authController.getProfile);
router.put('/profile', authenticate, authController.updateProfile);
router.put('/change-password', authenticate, authController.changePassword);

// Admin
router.post('/users', authenticate, requireAdmin, authController.createUser);
router.get('/users', authenticate, requireAdmin, authController.listUsers);

module.exports = router;
