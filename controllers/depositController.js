// controllers/depositController.js — Sanse Capital
// Usa MySQL2 pool directo (igual que adminController, dashboardController, etc.)

const { pool } = require('../config/database');
const { sendTelegram } = require('../utils/telegram');

// Genera un ref_id único tipo DEP-XXXXXXXX
function generateRefId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref = 'DEP-';
  for (let i = 0; i < 8; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

// ══════════════════════════════════════════════════════════
// POST /api/deposits/create
// Usuario envía comprobante → queda pendiente + alerta Telegram
// ══════════════════════════════════════════════════════════
exports.create = async (req, res) => {
  try {
    const { amount, note, proofImage, fileName } = req.body;
    const userId = req.user.id;

    if (!amount || isNaN(Number(amount)) || Number(amount) < 10000) {
      return res.status(400).json({ error: 'El monto mínimo es $10,000 COP' });
    }
    if (!proofImage) {
      return res.status(400).json({ error: 'El comprobante es requerido' });
    }

    const refId = generateRefId();

    const [result] = await pool.execute(
      `INSERT INTO deposit_requests
         (user_id, amount, proof_image, note, status, ref_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, NOW(), NOW())`,
      [userId, Number(amount), proofImage, note || '', refId]
    );

    const depositId = result.insertId;

    // Nombre del usuario para Telegram
    let userName = `ID ${userId}`;
    try {
      const [rows] = await pool.execute(
        'SELECT full_name, email FROM users WHERE id = ?', [userId]
      );
      if (rows.length > 0) userName = rows[0].full_name || rows[0].email || userName;
    } catch (_) {}

    // Notificación Telegram
    await sendTelegram(
      `💰 <b>Nuevo Depósito Pendiente</b>\n\n` +
      `👤 <b>Usuario:</b> ${userName}\n` +
      `💵 <b>Monto:</b> $${Number(amount).toLocaleString('es-CO')} COP\n` +
      `📝 <b>Nota:</b> ${note || 'Sin nota'}\n` +
      `🔖 <b>Ref:</b> ${refId}\n` +
      `🕐 <b>Fecha:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}\n` +
      `🔎 <b>Estado:</b> Pendiente de revisión`
    );

    return res.status(201).json({
      success: true,
      deposit: { id: depositId, refId, amount: Number(amount), status: 'pending' }
    });

  } catch (e) {
    console.error('[depositController.create]', e);
    return res.status(500).json({ error: 'Error interno al registrar el depósito' });
  }
};

// ══════════════════════════════════════════════════════════
// GET /api/deposits/my
// Lista los depósitos del usuario autenticado
// ══════════════════════════════════════════════════════════
exports.myDeposits = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, amount, note, status, ref_id, admin_notes, processed_at, created_at
       FROM deposit_requests
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  } catch (e) {
    console.error('[depositController.myDeposits]', e);
    return res.status(500).json({ error: 'Error al obtener depósitos' });
  }
};

// ══════════════════════════════════════════════════════════
// GET /api/admin/deposits
// Lista depósitos para el panel admin (con datos del usuario)
// ══════════════════════════════════════════════════════════
exports.adminGetDeposits = async (req, res) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT
        dr.id, dr.amount, dr.note, dr.status, dr.ref_id,
        dr.admin_notes, dr.proof_image, dr.processed_at, dr.created_at,
        u.id      AS user_id,
        u.full_name AS user_name,
        u.email   AS user_email
      FROM deposit_requests dr
      JOIN users u ON dr.user_id = u.id
    `;
    const params = [];
    if (status) {
      query += ' WHERE dr.status = ?';
      params.push(status);
    }
    query += ' ORDER BY dr.created_at DESC';

    const [rows] = await pool.execute(query, params);
    return res.json(rows);
  } catch (e) {
    console.error('[depositController.adminGetDeposits]', e);
    return res.status(500).json({ error: 'Error al obtener depósitos' });
  }
};

// ══════════════════════════════════════════════════════════
// POST /api/admin/deposits/:id/process
// Admin aprueba o rechaza un depósito
// Body: { action: 'approve' | 'reject', adminNote: '' }
// ══════════════════════════════════════════════════════════
exports.adminProcessDeposit = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, adminNote } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Acción inválida. Usa: approve | reject' });
    }

    // Obtener el depósito
    const [rows] = await pool.execute(
      `SELECT dr.*, u.full_name, u.email, u.id AS uid
       FROM deposit_requests dr
       JOIN users u ON dr.user_id = u.id
       WHERE dr.id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Depósito no encontrado' });

    const deposit = rows[0];
    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: `El depósito ya fue procesado (${deposit.status})` });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await pool.execute(
      `UPDATE deposit_requests
       SET status = ?, admin_notes = ?, processed_at = NOW(), processed_by = ?, updated_at = NOW()
       WHERE id = ?`,
      [newStatus, adminNote || '', req.user.id, id]
    );

    // Si se aprueba → registrar transacción de depósito y recalcular balance
    if (action === 'approve') {
      await pool.execute(
        `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at)
         VALUES (?, 'deposit', ?, ?, ?, NOW())`,
        [deposit.uid, deposit.amount, `Depósito aprobado — ${deposit.ref_id}`, deposit.ref_id]
      );

      // Recalcular balance (igual que adminController)
      const { recalculateAndSaveBalance } = require('../utils/balanceHelper');
      await recalculateAndSaveBalance(pool, deposit.uid);
    }

    // Telegram
    const emoji = action === 'approve' ? '✅' : '❌';
    const label = action === 'approve' ? 'Aprobado' : 'Rechazado';
    const userName = deposit.full_name || deposit.email;

    await sendTelegram(
      `${emoji} <b>Depósito ${label}</b>\n\n` +
      `🔖 <b>Ref:</b> ${deposit.ref_id}\n` +
      `👤 <b>Usuario:</b> ${userName}\n` +
      `💵 <b>Monto:</b> $${Number(deposit.amount).toLocaleString('es-CO')} COP\n` +
      `📝 <b>Nota admin:</b> ${adminNote || 'Sin nota'}\n` +
      `🕐 <b>Procesado:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    );

    return res.json({ success: true, status: newStatus });

  } catch (e) {
    console.error('[depositController.adminProcessDeposit]', e);
    return res.status(500).json({ error: 'Error al procesar el depósito' });
  }
};
