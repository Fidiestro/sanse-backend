// ═══════════════════════════════════════════════════════════════════════
// SANSE CAPITAL — controllers/cadenasController.js
// Módulo de CADENAS DE AHORRO (natillera / tanda rotativa)
//
// Modelo: N participantes inscritos. Cada período TODOS aportan la cuota.
// En cada período un participante (según su turn_order) recibe el pozo
// (= cuota × N). Hay N períodos. La cadena termina cuando todos recibieron.
//
// Flujo de dinero (decisiones tomadas):
//   • Cuota: el usuario paga desde su balance disponible  → recordTx(out)
//            o el admin la marca manual (sin tocar balance).
//   • Turno: el usuario RECLAMA el pozo con un botón       → recordTx(in)
//            o el admin lo marca entregado.
//
// Elegibilidad para INSCRIBIRSE (configurable abajo en ELIG):
//   • DGP/pool activo con monto >= 1.000.000  O
//   • LP COP activo con plazo > 6 meses (planes de 12m)
// ═══════════════════════════════════════════════════════════════════════

// ⚠️ ───────────────────────────────────────────────────────────────────
// AJUSTA ESTA LÍNEA: usa EXACTAMENTE el mismo require del pool que usan
// tus otros controllers (mira controllers/adminController.js arriba).
// Ejemplos comunes:  require('../config/db')  ·  require('../db')  ·  require('../config/database')
const pool = require('../config/database');
// ────────────────────────────────────────────────────────────────────────

// Configuración de elegibilidad — cambia aquí si quieres otros mínimos.
const ELIG = {
  dgpMinAmount: 1000000, // DGP/pool activo con monto >= este valor (COP)
  lpMinMonths : 6,       // LP COP activo con plazo ESTRICTAMENTE MAYOR a este nº de meses
};

// ─── Helpers de fecha ─────────────────────────────────────────────────
function stepDays(freq) { return freq === 'weekly' ? 7 : freq === 'biweekly' ? 14 : 30; }

// Suma k períodos a una fecha según la frecuencia.
function addPeriods(dateStr, freq, k) {
  const d = new Date(dateStr);
  if (freq === 'monthly') { d.setMonth(d.getMonth() + k); }
  else { d.setDate(d.getDate() + k * (freq === 'biweekly' ? 14 : 7)); }
  return d;
}

// ¿Cuántos períodos completos pasaron desde start hasta ahora?
function periodsElapsed(startStr, freq) {
  const start = new Date(startStr);
  const now = new Date();
  if (now < start) return 0;
  if (freq === 'monthly') {
    let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    if (now.getDate() < start.getDate()) months -= 1;
    return Math.max(0, months);
  }
  const days = Math.floor((now - start) / 86400000);
  return Math.floor(days / (freq === 'biweekly' ? 14 : 7));
}

function freqLabel(f) { return f === 'weekly' ? 'Semanal' : f === 'biweekly' ? 'Quincenal' : 'Mensual'; }
function refId(prefix, id) { return `${prefix}-${id}-${Date.now().toString(36).toUpperCase()}`; }

// ⚠️ ───────────────────────────────────────────────────────────────────
// INTEGRACIÓN DE BALANCE — inserta un movimiento en tu tabla `transactions`.
// Verifica que estas columnas coincidan con tu esquema real (mira cómo lo
// hace adminController al crear transacciones). El balance del usuario se
// recalcula desde `transactions` en tu backend.
//
// IMPORTANTE: para que el balance salga bien, tu lógica de recálculo debe
// tratar 'cadena' como SALIDA (resta) y 'cadena_payout' como ENTRADA (suma),
// igual que ya tratas 'withdraw' (salida) y 'deposit' (entrada).
// Si tu recálculo usa SUM(amount) con signo, guarda 'cadena' en negativo.
async function recordTx(conn, userId, type, amount, description, ref) {
  await conn.execute(
    `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [userId, type, amount, description || null, ref || null]
  );
}
// ────────────────────────────────────────────────────────────────────────

// Lee el balance disponible del usuario. Intenta varias fuentes comunes;
// ajusta si tu esquema difiere. Devuelve número (COP).
async function getAvailableBalance(conn, userId) {
  // Opción A: tabla balance_history (último registro)
  try {
    const [r] = await conn.execute(
      `SELECT amount FROM balance_history WHERE user_id=? ORDER BY id DESC LIMIT 1`, [userId]
    );
    if (r.length) return parseFloat(r[0].amount) || 0;
  } catch (e) { /* sigue */ }
  // Opción B: columna users.balance
  try {
    const [r] = await conn.execute(`SELECT balance FROM users WHERE id=?`, [userId]);
    if (r.length && r[0].balance != null) return parseFloat(r[0].balance) || 0;
  } catch (e) { /* sigue */ }
  return 0;
}

// ─── Elegibilidad ─────────────────────────────────────────────────────
// ⚠️ Verifica nombres de columnas de tu tabla `investments`
// (type, status, amount, duration_months).
async function checkEligibility(userId) {
  try {
    const [rows] = await pool.execute(
      `SELECT
         MAX(CASE WHEN LOWER(type) LIKE '%pool%'  AND status='active' AND amount >= ? THEN 1 ELSE 0 END) AS dgp_ok,
         MAX(CASE WHEN LOWER(type) NOT LIKE '%pool%' AND status='active' AND COALESCE(duration_months,0) > ? THEN 1 ELSE 0 END) AS lp_ok
       FROM investments WHERE user_id=?`,
      [ELIG.dgpMinAmount, ELIG.lpMinMonths, userId]
    );
    const dgpOk = !!(rows[0] && rows[0].dgp_ok);
    const lpOk  = !!(rows[0] && rows[0].lp_ok);
    return {
      eligible: dgpOk || lpOk,
      dgpOk, lpOk,
      requirement: `Necesitas una inversión DGP activa ≥ $${ELIG.dgpMinAmount.toLocaleString('es-CO')} o una inversión LP COP activa a más de ${ELIG.lpMinMonths} meses de plazo.`,
    };
  } catch (e) {
    console.error('[cadenas] checkEligibility error:', e.message);
    // En caso de error de esquema, no bloquear duro: marcar no elegible con motivo.
    return { eligible: false, dgpOk: false, lpOk: false, requirement: 'No se pudo verificar tu elegibilidad. Intenta más tarde.' };
  }
}

// Arma un objeto "vista" de la cadena con métricas calculadas.
function buildCadenaView(c, memberCount) {
  const n = memberCount || 0;
  const pot = parseFloat(c.cuota) * n;                  // pozo aprox con los inscritos
  const endDate = n > 0 ? addPeriods(c.start_date, c.frequency, n) : null;
  let currentPeriod = 0;
  if (c.status === 'active' && n > 0) {
    currentPeriod = Math.min(n, periodsElapsed(c.start_date, c.frequency) + 1);
  }
  return {
    id: c.id,
    name: c.name,
    cuota: parseFloat(c.cuota),
    frequency: c.frequency,
    frequencyLabel: freqLabel(c.frequency),
    startDate: c.start_date,
    registrationDeadline: c.registration_deadline,
    maxParticipants: c.max_participants,
    status: c.status,
    notes: c.notes,
    participants: n,
    potValue: pot,                                       // valor aprox de la cadena
    estimatedEndDate: endDate,
    totalPeriods: n,
    currentPeriod,
    createdAt: c.created_at,
  };
}

// ════════════════════════════════════════════════════════════════════════
// USUARIO
// ════════════════════════════════════════════════════════════════════════

// GET /api/cadenas/eligibility
exports.getEligibility = async (req, res) => {
  try {
    const elig = await checkEligibility(req.user.id);
    res.json(elig);
  } catch (e) { res.status(500).json({ error: 'Error verificando elegibilidad' }); }
};

// GET /api/cadenas  → cadenas abiertas + en las que participa el usuario
exports.listCadenas = async (req, res) => {
  try {
    const uid = req.user.id;
    const [cadenas] = await pool.execute(
      `SELECT c.*,
              (SELECT COUNT(*) FROM cadena_members m WHERE m.cadena_id=c.id AND m.status IN ('registered','active')) AS member_count,
              (SELECT COUNT(*) FROM cadena_members m WHERE m.cadena_id=c.id AND m.user_id=? AND m.status IN ('registered','active')) AS i_am_in
       FROM cadenas c
       WHERE c.status IN ('open','active') OR c.id IN (SELECT cadena_id FROM cadena_members WHERE user_id=?)
       ORDER BY c.status='open' DESC, c.start_date ASC`,
      [uid, uid]
    );
    const out = cadenas.map(c => {
      const v = buildCadenaView(c, c.member_count);
      v.iAmIn = !!c.i_am_in;
      return v;
    });
    res.json({ cadenas: out });
  } catch (e) {
    console.error('[cadenas] listCadenas:', e.message);
    res.status(500).json({ error: 'Error cargando cadenas' });
  }
};

// GET /api/cadenas/:id  → detalle para el usuario
exports.getCadena = async (req, res) => {
  try {
    const uid = req.user.id;
    const id = req.params.id;
    const [rows] = await pool.execute(`SELECT * FROM cadenas WHERE id=?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Cadena no encontrada' });
    const c = rows[0];

    const [members] = await pool.execute(
      `SELECT m.user_id, m.turn_order, m.status, u.full_name
       FROM cadena_members m JOIN users u ON u.id=m.user_id
       WHERE m.cadena_id=? AND m.status IN ('registered','active')
       ORDER BY (m.turn_order IS NULL), m.turn_order ASC, m.joined_at ASC`,
      [id]
    );
    const n = members.length;
    const v = buildCadenaView(c, n);

    const mine = members.find(m => m.user_id === uid) || null;
    v.iAmIn = !!mine;
    v.myTurn = mine ? mine.turn_order : null;

    // Mis pagos
    const [myPays] = await pool.execute(
      `SELECT period_number, amount, method, paid_at FROM cadena_payments WHERE cadena_id=? AND user_id=? ORDER BY period_number`,
      [id, uid]
    );
    v.myPayments = myPays;

    // ¿Pagué el período actual?
    v.paidCurrentPeriod = v.currentPeriod > 0 && myPays.some(p => p.period_number === v.currentPeriod);

    // Mi payout (si tengo turno)
    let myPayout = null;
    if (mine && mine.turn_order) {
      const [po] = await pool.execute(
        `SELECT * FROM cadena_payouts WHERE cadena_id=? AND period_number=?`, [id, mine.turn_order]
      );
      myPayout = po.length ? po[0] : null;
    }
    v.myPayout = myPayout;
    // ¿Puedo reclamar? Es mi turno (turn_order == currentPeriod) y no reclamado aún.
    v.canClaim = !!(mine && mine.turn_order && v.currentPeriod >= mine.turn_order &&
                    (!myPayout || myPayout.status === 'pending'));

    // Recaudado del período actual (transparencia)
    if (v.currentPeriod > 0) {
      const [collected] = await pool.execute(
        `SELECT COUNT(*) AS paid_count, COALESCE(SUM(amount),0) AS collected
         FROM cadena_payments WHERE cadena_id=? AND period_number=?`, [id, v.currentPeriod]
      );
      v.currentCollected = parseFloat(collected[0].collected) || 0;
      v.currentPaidCount = collected[0].paid_count || 0;
    }

    v.members = members.map(m => ({ name: m.full_name, turn: m.turn_order, isMe: m.user_id === uid }));
    v.eligibility = await checkEligibility(uid);
    res.json(v);
  } catch (e) {
    console.error('[cadenas] getCadena:', e.message);
    res.status(500).json({ error: 'Error cargando la cadena' });
  }
};

// POST /api/cadenas/:id/join  → inscribirme
exports.joinCadena = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const uid = req.user.id;
    const id = req.params.id;

    // Elegibilidad (requisito de inversión)
    const elig = await checkEligibility(uid);
    if (!elig.eligible) {
      conn.release();
      return res.status(403).json({ error: elig.requirement, code: 'NOT_ELIGIBLE' });
    }

    await conn.beginTransaction();
    const [rows] = await conn.execute(`SELECT * FROM cadenas WHERE id=? FOR UPDATE`, [id]);
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ error: 'Cadena no encontrada' }); }
    const c = rows[0];

    if (c.status !== 'open') { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Las inscripciones para esta cadena están cerradas' }); }
    if (new Date() > new Date(c.registration_deadline + 'T23:59:59')) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'La fecha límite de inscripción ya pasó' }); }

    const [already] = await conn.execute(
      `SELECT id FROM cadena_members WHERE cadena_id=? AND user_id=? AND status IN ('registered','active')`, [id, uid]
    );
    if (already.length) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Ya estás inscrito en esta cadena' }); }

    if (c.max_participants) {
      const [cnt] = await conn.execute(
        `SELECT COUNT(*) AS n FROM cadena_members WHERE cadena_id=? AND status IN ('registered','active')`, [id]
      );
      if (cnt[0].n >= c.max_participants) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'La cadena ya alcanzó el cupo máximo' }); }
    }

    await conn.execute(
      `INSERT INTO cadena_members (cadena_id, user_id, status) VALUES (?, ?, 'registered')`, [id, uid]
    );
    await conn.commit();
    conn.release();
    res.json({ success: true, message: 'Te inscribiste en la cadena' });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    console.error('[cadenas] joinCadena:', e.message);
    res.status(500).json({ error: 'Error al inscribirte' });
  }
};

// POST /api/cadenas/:id/pay  → pagar la cuota del período actual (desde balance)
exports.payCuota = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const uid = req.user.id;
    const id = req.params.id;
    await conn.beginTransaction();

    const [rows] = await conn.execute(`SELECT * FROM cadenas WHERE id=? FOR UPDATE`, [id]);
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ error: 'Cadena no encontrada' }); }
    const c = rows[0];
    if (c.status !== 'active') { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'La cadena no está activa todavía' }); }

    const [mem] = await conn.execute(
      `SELECT * FROM cadena_members WHERE cadena_id=? AND user_id=? AND status IN ('registered','active')`, [id, uid]
    );
    if (!mem.length) { await conn.rollback(); conn.release(); return res.status(403).json({ error: 'No participas en esta cadena' }); }

    const [cnt] = await conn.execute(
      `SELECT COUNT(*) AS n FROM cadena_members WHERE cadena_id=? AND status IN ('registered','active')`, [id]
    );
    const n = cnt[0].n;
    const period = Math.min(n, periodsElapsed(c.start_date, c.frequency) + 1);
    if (period < 1) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Aún no inicia el primer período' }); }

    const [paid] = await conn.execute(
      `SELECT id FROM cadena_payments WHERE cadena_id=? AND user_id=? AND period_number=?`, [id, uid, period]
    );
    if (paid.length) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Ya pagaste la cuota de este período' }); }

    const cuota = parseFloat(c.cuota);
    const bal = await getAvailableBalance(conn, uid);
    if (bal < cuota) { await conn.rollback(); conn.release(); return res.status(400).json({ error: `Saldo insuficiente. Disponible: $${Math.round(bal).toLocaleString('es-CO')}` }); }

    const ref = refId('CADPAY', id);
    await recordTx(conn, uid, 'cadena', cuota, `Cuota cadena "${c.name}" · período ${period}`, ref);
    await conn.execute(
      `INSERT INTO cadena_payments (cadena_id, user_id, period_number, amount, method, ref_id) VALUES (?, ?, ?, ?, 'balance', ?)`,
      [id, uid, period, cuota, ref]
    );

    await conn.commit();
    conn.release();
    res.json({ success: true, message: `Cuota del período ${period} pagada`, amount: cuota, period });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    console.error('[cadenas] payCuota:', e.message);
    res.status(500).json({ error: 'Error al pagar la cuota' });
  }
};

// POST /api/cadenas/:id/claim  → reclamar el pozo cuando es mi turno
exports.claimPayout = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const uid = req.user.id;
    const id = req.params.id;
    await conn.beginTransaction();

    const [rows] = await conn.execute(`SELECT * FROM cadenas WHERE id=? FOR UPDATE`, [id]);
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ error: 'Cadena no encontrada' }); }
    const c = rows[0];
    if (c.status !== 'active') { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'La cadena no está activa' }); }

    const [mem] = await conn.execute(
      `SELECT * FROM cadena_members WHERE cadena_id=? AND user_id=? AND status IN ('registered','active')`, [id, uid]
    );
    if (!mem.length || !mem[0].turn_order) { await conn.rollback(); conn.release(); return res.status(403).json({ error: 'No tienes turno asignado en esta cadena' }); }
    const myTurn = mem[0].turn_order;

    const [cnt] = await conn.execute(
      `SELECT COUNT(*) AS n FROM cadena_members WHERE cadena_id=? AND status IN ('registered','active')`, [id]
    );
    const n = cnt[0].n;
    const currentPeriod = Math.min(n, periodsElapsed(c.start_date, c.frequency) + 1);
    if (currentPeriod < myTurn) { await conn.rollback(); conn.release(); return res.status(400).json({ error: `Aún no es tu turno (te toca en el período ${myTurn})` }); }

    const [po] = await conn.execute(`SELECT * FROM cadena_payouts WHERE cadena_id=? AND period_number=? FOR UPDATE`, [id, myTurn]);
    if (po.length && po[0].status !== 'pending') { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Ya reclamaste este turno' }); }

    const pot = parseFloat(c.cuota) * n;
    const ref = refId('CADOUT', id);
    await recordTx(conn, uid, 'cadena_payout', pot, `Cobro cadena "${c.name}" · turno ${myTurn}`, ref);

    if (po.length) {
      await conn.execute(
        `UPDATE cadena_payouts SET status='claimed', amount=?, ref_id=?, claimed_at=NOW() WHERE id=?`,
        [pot, ref, po[0].id]
      );
    } else {
      await conn.execute(
        `INSERT INTO cadena_payouts (cadena_id, user_id, period_number, amount, status, ref_id, claimed_at)
         VALUES (?, ?, ?, ?, 'claimed', ?, NOW())`,
        [id, uid, myTurn, pot, ref]
      );
    }

    // ¿Era el último turno? marcar cadena completada.
    if (myTurn >= n) {
      await conn.execute(`UPDATE cadenas SET status='completed' WHERE id=?`, [id]);
    }

    await conn.commit();
    conn.release();
    res.json({ success: true, message: 'Pozo reclamado y acreditado a tu balance', amount: pot });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    console.error('[cadenas] claimPayout:', e.message);
    res.status(500).json({ error: 'Error al reclamar el pozo' });
  }
};

// ════════════════════════════════════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════════════════════════════════════

// GET /api/admin/cadenas  → todas las cadenas con stats
exports.adminList = async (req, res) => {
  try {
    const [cadenas] = await pool.execute(
      `SELECT c.*,
              (SELECT COUNT(*) FROM cadena_members m WHERE m.cadena_id=c.id AND m.status IN ('registered','active')) AS member_count
       FROM cadenas c ORDER BY c.created_at DESC`
    );
    res.json({ cadenas: cadenas.map(c => buildCadenaView(c, c.member_count)) });
  } catch (e) {
    console.error('[cadenas] adminList:', e.message);
    res.status(500).json({ error: 'Error cargando cadenas' });
  }
};

// POST /api/admin/cadenas  → crear cadena
exports.adminCreate = async (req, res) => {
  try {
    const { name, cuota, frequency, startDate, registrationDeadline, maxParticipants, notes } = req.body;
    if (!name || !cuota || !startDate || !registrationDeadline) {
      return res.status(400).json({ error: 'Faltan campos: nombre, cuota, fecha de inicio y fecha límite' });
    }
    const freq = ['weekly', 'biweekly', 'monthly'].includes(frequency) ? frequency : 'monthly';
    const [r] = await pool.execute(
      `INSERT INTO cadenas (name, cuota, frequency, start_date, registration_deadline, max_participants, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
      [name, parseFloat(cuota), freq, startDate, registrationDeadline, maxParticipants || null, notes || null]
    );
    res.json({ success: true, id: r.insertId, message: 'Cadena creada' });
  } catch (e) {
    console.error('[cadenas] adminCreate:', e.message);
    res.status(500).json({ error: 'Error al crear la cadena' });
  }
};

// GET /api/admin/cadenas/:id  → detalle admin
exports.adminGet = async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.execute(`SELECT * FROM cadenas WHERE id=?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Cadena no encontrada' });
    const c = rows[0];

    const [members] = await pool.execute(
      `SELECT m.id, m.user_id, m.turn_order, m.status, m.joined_at, u.full_name, u.email
       FROM cadena_members m JOIN users u ON u.id=m.user_id
       WHERE m.cadena_id=? ORDER BY (m.turn_order IS NULL), m.turn_order ASC, m.joined_at ASC`, [id]
    );
    const active = members.filter(m => ['registered', 'active'].includes(m.status));
    const v = buildCadenaView(c, active.length);

    const [payments] = await pool.execute(
      `SELECT p.*, u.full_name FROM cadena_payments p JOIN users u ON u.id=p.user_id WHERE p.cadena_id=? ORDER BY p.period_number, p.paid_at`, [id]
    );
    const [payouts] = await pool.execute(
      `SELECT po.*, u.full_name FROM cadena_payouts po JOIN users u ON u.id=po.user_id WHERE po.cadena_id=? ORDER BY po.period_number`, [id]
    );

    v.membersDetailed = members.map(m => ({
      memberId: m.id, userId: m.user_id, name: m.full_name, email: m.email,
      turn: m.turn_order, status: m.status, joinedAt: m.joined_at,
    }));
    v.payments = payments;
    v.payouts = payouts;
    res.json(v);
  } catch (e) {
    console.error('[cadenas] adminGet:', e.message);
    res.status(500).json({ error: 'Error cargando el detalle' });
  }
};

// POST /api/admin/cadenas/:id/start  → iniciar (asigna turnos y pasa a 'active')
// body opcional: { order: [userId1, userId2, ...] }  (si no, usa orden de inscripción)
exports.adminStart = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    await conn.beginTransaction();
    const [rows] = await conn.execute(`SELECT * FROM cadenas WHERE id=? FOR UPDATE`, [id]);
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ error: 'Cadena no encontrada' }); }
    const c = rows[0];
    if (c.status !== 'open') { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'La cadena ya fue iniciada o cerrada' }); }

    const [members] = await conn.execute(
      `SELECT user_id FROM cadena_members WHERE cadena_id=? AND status IN ('registered','active') ORDER BY joined_at ASC`, [id]
    );
    if (members.length < 2) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Se necesitan al menos 2 participantes' }); }

    // Orden: el que mande el admin, o por inscripción.
    let order = (req.body && Array.isArray(req.body.order) && req.body.order.length === members.length)
      ? req.body.order
      : members.map(m => m.user_id);

    let turn = 1;
    for (const userId of order) {
      await conn.execute(
        `UPDATE cadena_members SET turn_order=?, status='active' WHERE cadena_id=? AND user_id=?`,
        [turn, id, userId]
      );
      turn++;
    }
    await conn.execute(`UPDATE cadenas SET status='active' WHERE id=?`, [id]);
    await conn.commit();
    conn.release();
    res.json({ success: true, message: `Cadena iniciada con ${members.length} participantes` });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    console.error('[cadenas] adminStart:', e.message);
    res.status(500).json({ error: 'Error al iniciar la cadena' });
  }
};

// POST /api/admin/cadenas/:id/mark-paid  → marcar cuota manual
// body: { userId, periodNumber }
exports.adminMarkPaid = async (req, res) => {
  try {
    const id = req.params.id;
    const { userId, periodNumber } = req.body;
    if (!userId || !periodNumber) return res.status(400).json({ error: 'Falta userId o periodNumber' });
    const [rows] = await pool.execute(`SELECT cuota, name FROM cadenas WHERE id=?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Cadena no encontrada' });
    const cuota = parseFloat(rows[0].cuota);
    await pool.execute(
      `INSERT INTO cadena_payments (cadena_id, user_id, period_number, amount, method, ref_id)
       VALUES (?, ?, ?, ?, 'manual', ?)
       ON DUPLICATE KEY UPDATE method='manual', amount=VALUES(amount)`,
      [id, userId, periodNumber, cuota, refId('CADMAN', id)]
    );
    res.json({ success: true, message: 'Cuota marcada como pagada (manual)' });
  } catch (e) {
    console.error('[cadenas] adminMarkPaid:', e.message);
    res.status(500).json({ error: 'Error al marcar el pago' });
  }
};

// POST /api/admin/cadenas/:id/deliver  → marcar pozo entregado (sin tocar balance)
// body: { periodNumber }
exports.adminDeliverPayout = async (req, res) => {
  try {
    const id = req.params.id;
    const { periodNumber } = req.body;
    if (!periodNumber) return res.status(400).json({ error: 'Falta periodNumber' });
    const [rows] = await pool.execute(`SELECT * FROM cadenas WHERE id=?`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Cadena no encontrada' });
    const c = rows[0];
    const [mem] = await pool.execute(
      `SELECT user_id FROM cadena_members WHERE cadena_id=? AND turn_order=?`, [id, periodNumber]
    );
    if (!mem.length) return res.status(400).json({ error: 'No hay miembro con ese turno' });
    const [cnt] = await pool.execute(
      `SELECT COUNT(*) AS n FROM cadena_members WHERE cadena_id=? AND status IN ('registered','active')`, [id]
    );
    const pot = parseFloat(c.cuota) * cnt[0].n;
    await pool.execute(
      `INSERT INTO cadena_payouts (cadena_id, user_id, period_number, amount, status, ref_id, claimed_at)
       VALUES (?, ?, ?, ?, 'delivered', ?, NOW())
       ON DUPLICATE KEY UPDATE status='delivered', claimed_at=NOW()`,
      [id, mem[0].user_id, periodNumber, pot, refId('CADDLV', id)]
    );
    res.json({ success: true, message: 'Pozo marcado como entregado' });
  } catch (e) {
    console.error('[cadenas] adminDeliverPayout:', e.message);
    res.status(500).json({ error: 'Error al marcar entrega' });
  }
};

// POST /api/admin/cadenas/:id/cancel  → cancelar cadena (cancelación SUAVE, no borra)
exports.adminCancel = async (req, res) => {
  try {
    const id = req.params.id;
    await pool.execute(`UPDATE cadenas SET status='cancelled' WHERE id=?`, [id]);
    res.json({ success: true, message: 'Cadena cancelada' });
  } catch (e) {
    console.error('[cadenas] adminCancel:', e.message);
    res.status(500).json({ error: 'Error al cancelar' });
  }
};

// POST /api/admin/cadenas/:id/remove-member  → quitar miembro (suave)
// body: { userId }
exports.adminRemoveMember = async (req, res) => {
  try {
    const id = req.params.id;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Falta userId' });
    await pool.execute(
      `UPDATE cadena_members SET status='removed' WHERE cadena_id=? AND user_id=?`, [id, userId]
    );
    res.json({ success: true, message: 'Miembro removido de la cadena' });
  } catch (e) {
    console.error('[cadenas] adminRemoveMember:', e.message);
    res.status(500).json({ error: 'Error al remover miembro' });
  }
};