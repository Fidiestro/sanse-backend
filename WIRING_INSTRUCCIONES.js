// ═══════════════════════════════════════════════════════════════════════
// SANSE CAPITAL — Cómo conectar el módulo CADENAS
// NO reemplaces archivos: solo AÑADE estas líneas. No se borra nada.
// ═══════════════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────────────
// PASO 1 · En server.js  → monta las rutas de USUARIO
// (cerca de donde montas las otras: app.use('/api/investments', ...))
// ───────────────────────────────────────────────────────────────────────
app.use('/api/cadenas', require('./routes/cadenas'));


// ───────────────────────────────────────────────────────────────────────
// PASO 2 · En routes/admin.js  → añade las rutas de ADMIN.
// routes/admin.js ya está protegido con auth + isAdmin, así que solo
// requiere el controller y agrega las rutas. Pégalo cerca del top con los
// otros require, y las rutas junto a las demás de admin.
// ───────────────────────────────────────────────────────────────────────

// (arriba, junto a los otros require)
const cadenasController = require('../controllers/cadenasController');

// (junto a las otras rutas del router admin)
router.get ('/cadenas',                 cadenasController.adminList);
router.post('/cadenas',                 cadenasController.adminCreate);
router.get ('/cadenas/:id',             cadenasController.adminGet);
router.post('/cadenas/:id/start',       cadenasController.adminStart);
router.post('/cadenas/:id/mark-paid',   cadenasController.adminMarkPaid);
router.post('/cadenas/:id/deliver',     cadenasController.adminDeliverPayout);
router.post('/cadenas/:id/cancel',      cadenasController.adminCancel);
router.post('/cadenas/:id/remove-member', cadenasController.adminRemoveMember);


// ───────────────────────────────────────────────────────────────────────
// PASO 3 · Ejecuta la migración SQL  003_create_cadenas.sql  en tu MySQL.
// ───────────────────────────────────────────────────────────────────────


// ───────────────────────────────────────────────────────────────────────
// PASO 4 (opcional pero recomendado) · INTEGRACIÓN DE BALANCE
// Donde tu backend recalcula el balance desde `transactions`, asegúrate de
// que estos dos tipos queden clasificados:
//    'cadena'         → SALIDA  (resta, como 'withdraw')
//    'cadena_payout'  → ENTRADA (suma,  como 'deposit')
// Si tu recálculo usa SUM(amount) por signo, no hace falta nada; si usa
// listas por tipo, añade 'cadena' a los OUTFLOW y 'cadena_payout' a INFLOW.
// ───────────────────────────────────────────────────────────────────────