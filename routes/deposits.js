const router  = require('express').Router();
const ctrl    = require('../controllers/depositController');
const auth    = require('../middleware/auth');       // tu middleware JWT existente
// Si tienes middleware de admin, importalo así:
// const isAdmin = require('../middleware/isAdmin');

// ── Rutas de usuario ──────────────────────────
// POST /api/deposits/create  → registra nuevo depósito pendiente
router.post('/create', auth, ctrl.create);

// GET /api/deposits/my  → lista depósitos del usuario autenticado
router.get('/my', auth, ctrl.myDeposits);

// ── Rutas de admin ────────────────────────────
// PUT /api/deposits/:id/approve  → aprobar un depósito
// router.put('/:id/approve', auth, isAdmin, ctrl.approve);
// (descomenta cuando tengas middleware de admin listo)

module.exports = router;
