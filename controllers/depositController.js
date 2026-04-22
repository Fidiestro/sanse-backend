const { sendTelegram } = require('../utils/telegram');

// ──────────────────────────────────────────────
// Ajusta estas importaciones según tu ORM / BD:
//   Sequelize:  const { Deposit, User } = require('../models');
//   Mongoose:   const Deposit = require('../models/Deposit');
//               const User    = require('../models/User');
// ──────────────────────────────────────────────
const { Deposit, User } = require('../models');

/**
 * POST /api/deposits/create
 * Registra un nuevo depósito pendiente y notifica al admin por Telegram.
 */
exports.create = async (req, res) => {
  try {
    const { amount, note, proofImage, fileName } = req.body;
    const userId = req.user.id; // inyectado por middleware de auth

    // ── Validación básica ──────────────────────
    if (!amount || isNaN(Number(amount)) || Number(amount) < 10000) {
      return res.status(400).json({ error: 'El monto mínimo es $10,000 COP' });
    }
    if (!proofImage) {
      return res.status(400).json({ error: 'El comprobante es requerido' });
    }

    // ── Crear depósito en BD ───────────────────
    const deposit = await Deposit.create({
      userId,
      amount:     Number(amount),
      note:       note || '',
      proofImage: proofImage,   // base64 de la imagen
      fileName:   fileName || 'comprobante.jpg',
      status:     'pending'
    });

    // ── Notificación Telegram ──────────────────
    let userName = `ID ${userId}`;
    try {
      const user = await User.findByPk(userId);
      if (user) userName = user.fullName || user.email || userName;
    } catch (_) {}

    await sendTelegram(
      `💰 <b>Nuevo Depósito Pendiente</b>\n\n` +
      `👤 <b>Usuario:</b> ${userName}\n` +
      `💵 <b>Monto:</b> $${Number(amount).toLocaleString('es-CO')} COP\n` +
      `📝 <b>Nota:</b> ${note || 'Sin nota'}\n` +
      `🕐 <b>Fecha:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}\n` +
      `🔎 <b>Estado:</b> Pendiente de revisión\n` +
      `🆔 <b>Depósito ID:</b> ${deposit.id}`
    );

    return res.status(201).json({ success: true, deposit });

  } catch (e) {
    console.error('[depositController.create]', e);
    return res.status(500).json({ error: 'Error interno al registrar el depósito' });
  }
};

/**
 * GET /api/deposits/my
 * Lista los depósitos del usuario autenticado.
 */
exports.myDeposits = async (req, res) => {
  try {
    const deposits = await Deposit.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']]
    });
    return res.json(deposits);
  } catch (e) {
    console.error('[depositController.myDeposits]', e);
    return res.status(500).json({ error: 'Error al obtener depósitos' });
  }
};

/**
 * PUT /api/deposits/:id/approve   (solo admin)
 * Aprueba un depósito y notifica al usuario.
 */
exports.approve = async (req, res) => {
  try {
    const deposit = await Deposit.findByPk(req.params.id);
    if (!deposit) return res.status(404).json({ error: 'Depósito no encontrado' });

    await deposit.update({ status: 'approved' });

    // Notificación al admin
    await sendTelegram(
      `✅ <b>Depósito Aprobado</b>\n\n` +
      `🆔 <b>ID:</b> ${deposit.id}\n` +
      `💵 <b>Monto:</b> $${Number(deposit.amount).toLocaleString('es-CO')} COP\n` +
      `🕐 <b>Aprobado:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    );

    return res.json({ success: true, deposit });
  } catch (e) {
    console.error('[depositController.approve]', e);
    return res.status(500).json({ error: 'Error al aprobar el depósito' });
  }
};
