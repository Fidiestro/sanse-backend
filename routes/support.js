// ════════════════════════════════════════════════════════════════════════
// routes/support.js — Sanse Capital
// Rutas del chat de soporte (LADO USUARIO).
// Las rutas de admin están en routes/admin.js (montadas en /api/admin/support/*).
// ════════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const supportController = require('../controllers/supportController');
const { authenticate } = require('../middleware/auth');

// Todas las rutas requieren autenticación
router.use(authenticate);

// ── Chat ──────────────────────────────────────────────────────
router.post('/chat',          supportController.openChat);
router.get( '/chat',          supportController.getMyChat);
router.post('/chat/message',  supportController.sendMessageUser);
router.get( '/chat/messages', supportController.getMessagesUser);
router.post('/chat/close',    supportController.closeChatUser);

module.exports = router;