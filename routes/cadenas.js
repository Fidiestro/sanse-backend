// ═══════════════════════════════════════════════════════════════════════
// SANSE CAPITAL — routes/cadenas.js  (rutas de USUARIO)
// Montar en server.js:   app.use('/api/cadenas', require('./routes/cadenas'));
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const cadenas = require('../controllers/cadenasController');

// ⚠️ AJUSTA ESTA LÍNEA: usa el MISMO middleware de autenticación que usan
// tus otras rutas de usuario (mira routes/investments.js o routes/user.js).
// Ejemplos comunes:
//   const { authenticate } = require('../middleware/auth');
//   const auth = require('../middleware/auth');
const { authenticate } = require('../middleware/auth');

// Protege todas las rutas (req.user debe quedar disponible)
router.use(authenticate);

router.get('/eligibility',  cadenas.getEligibility);
router.get('/',             cadenas.listCadenas);
router.get('/:id',          cadenas.getCadena);
router.post('/:id/join',    cadenas.joinCadena);
router.post('/:id/pay',     cadenas.payCuota);
router.post('/:id/claim',   cadenas.claimPayout);

module.exports = router;