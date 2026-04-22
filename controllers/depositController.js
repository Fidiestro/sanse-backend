const { sendTelegram } = require('../utils/telegram');
const { Deposit, User } = require('../models');

// ══════════════════════════════════════════════
// RUTAS DE USUARIO
// ══════════════════════════════════════════════

/**
 * POST /api/deposits/create
 * Usuario envía comprobante → depósito queda pendiente + alerta Telegram
 */
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

    const deposit = await Deposit.create({
      userId,
      amount:     Number(amount),
      note:       note || '',
      proofImage: proofImage,
      fileName:   fileName || 'comprobante.jpg',
      status:     'pending'
    });

    // Nombre del usuario para la alerta
    let userName = `ID ${userId}`;
    try {
      const user = await User.findByPk(userId);
      if (user) userName = user.fullName || user.full_name || user.email || userName;
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
 * Lista los depósitos del usuario autenticado (sin el base64 pesado)
 */
exports.myDeposits = async (req, res) => {
  try {
    const deposits = await Deposit.findAll({
      where:      { userId: req.user.id },
      order:      [['createdAt', 'DESC']],
      attributes: { exclude: ['proofImage'] }
    });
    return res.json(deposits);
  } catch (e) {
    console.error('[depositController.myDeposits]', e);
    return res.status(500).json({ error: 'Error al obtener depósitos' });
  }
};

// ══════════════════════════════════════════════
// RUTAS DE ADMIN
// (usadas por routes/admin.js)
// ══════════════════════════════════════════════

/**
 * GET /api/admin/deposits
 * Lista todos los depósitos pendientes para el panel admin
 */
exports.adminGetDeposits = async (req, res) => {
  try {
    const { status } = req.query; // opcional: ?status=pending

    const where = {};
    if (status) where.status = status;

    const deposits = await Deposit.findAll({
      where,
      order: [['createdAt', 'DESC']],
      include: [
        {
          model:      User,
          as:         'user',
          attributes: ['id', 'fullName', 'full_name', 'email']
        }
      ]
    });

    return res.json(deposits);
  } catch (e) {
    console.error('[depositController.adminGetDeposits]', e);
    return res.status(500).json({ error: 'Error al obtener depósitos' });
  }
};

/**
 * POST /api/admin/deposits/:id/process
 * Admin aprueba o rechaza un depósito
 * Body: { action: 'approve' | 'reject', adminNote: '' }
 */
exports.adminProcessDeposit = async (req, res) => {
  try {
    const { id }        = req.params;
    const { action, adminNote } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Acción inválida. Usa: approve | reject' });
    }

    const deposit = await Deposit.findByPk(id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'fullName', 'full_name', 'email'] }]
    });

    if (!deposit) {
      return res.status(404).json({ error: 'Depósito no encontrado' });
    }
    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: `El depósito ya fue procesado (${deposit.status})` });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await deposit.update({ status: newStatus, adminNote: adminNote || '' });

    // Telegram al admin
    const emoji  = action === 'approve' ? '✅' : '❌';
    const label  = action === 'approve' ? 'Aprobado' : 'Rechazado';
    const userName = deposit.user
      ? (deposit.user.fullName || deposit.user.full_name || deposit.user.email)
      : `ID ${deposit.userId}`;

    await sendTelegram(
      `${emoji} <b>Depósito ${label}</b>\n\n` +
      `🆔 <b>ID:</b> ${deposit.id}\n` +
      `👤 <b>Usuario:</b> ${userName}\n` +
      `💵 <b>Monto:</b> $${Number(deposit.amount).toLocaleString('es-CO')} COP\n` +
      `📝 <b>Nota admin:</b> ${adminNote || 'Sin nota'}\n` +
      `🕐 <b>Procesado:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    );

    return res.json({ success: true, deposit });

  } catch (e) {
    console.error('[depositController.adminProcessDeposit]', e);
    return res.status(500).json({ error: 'Error al procesar el depósito' });
  }
};

/**
 * PUT /api/deposits/:id/approve  (alias legacy — mantenido por compatibilidad)
 */
exports.approve = async (req, res) => {
  req.body.action = 'approve';
  req.params.id   = req.params.id;
  return exports.adminProcessDeposit(req, res);
};
