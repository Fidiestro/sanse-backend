// =====================================================
// SANSE CAPITAL - POOL DE LIQUIDEZ
// Routes Backend Implementation (Node.js + Express)
// =====================================================

const express = require('express');
const router = express.Router();

// =====================================================
// HELPER FUNCTIONS
// =====================================================

// Obtener balance disponible del usuario
async function getAvailableBalance(userId, db) {
  const result = await db.query(
    'SELECT available_balance FROM user_balances WHERE user_id = ?',
    [userId]
  );
  return result[0]?.available_balance || 0;
}

// Descontar del balance
async function deductFromBalance(userId, amount, db) {
  await db.query(
    'UPDATE user_balances SET available_balance = available_balance - ? WHERE user_id = ?',
    [amount, userId]
  );
}

// Agregar al balance
async function addToBalance(userId, amount, db) {
  await db.query(
    'UPDATE user_balances SET available_balance = available_balance + ? WHERE user_id = ?',
    [amount, userId]
  );
}

// =====================================================
// POST /investments/create
// Crear nueva inversión (CDTC o Pool)
// =====================================================

router.post('/investments/create', async (req, res) => {
  const { type, amount, productId, durationMonths } = req.body;
  const userId = req.user.id; // De tu middleware de autenticación
  const db = req.db; // Tu conexión a la base de datos

  try {
    // Validar saldo disponible
    const balance = await getAvailableBalance(userId, db);
    if (amount > balance) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    // ==================== POOL DE LIQUIDEZ ====================
    if (type === 'pool') {
      // Validar monto mínimo
      if (amount < 50000) {
        return res.status(400).json({ error: 'Monto mínimo para Pool: $50,000 COP' });
      }

      // Calcular comisión de entrada (2%)
      const entryFee = Math.round(amount * 0.02);
      const netCapital = amount - entryFee;

      // Fechas
      const startDate = new Date();
      const lockEndDate = new Date(startDate);
      lockEndDate.setMonth(lockEndDate.getMonth() + 12); // Bloqueado 12 meses

      // Crear inversión
      const result = await db.query(
        `INSERT INTO investments 
         (user_id, type, amount, net_capital, entry_fee, start_date, lock_end_date, 
          duration_months, status, withdrawable_earnings, created_at) 
         VALUES (?, 'pool', ?, ?, ?, ?, ?, 12, 'active', 0, NOW())`,
        [userId, amount, netCapital, entryFee, startDate, lockEndDate]
      );

      // Descontar del balance
      await deductFromBalance(userId, amount, db);

      // Registrar transacción
      await db.query(
        `INSERT INTO transactions (user_id, type, amount, description, status, created_at) 
         VALUES (?, 'pool_investment', ?, ?, 'completed', NOW())`,
        [
          userId, 
          amount, 
          `Inversión en Pool de Liquidez (Capital neto: $${netCapital.toLocaleString('es-CO')}, Comisión: $${entryFee.toLocaleString('es-CO')})`
        ]
      );

      return res.json({
        success: true,
        message: 'Inversión en Pool creada exitosamente',
        investment: {
          id: result.insertId,
          type: 'pool',
          amount,
          netCapital,
          entryFee,
          startDate,
          lockEndDate,
          durationMonths: 12
        }
      });
    }

    // ==================== CDTC (Lógica existente) ====================
    else {
      // Validar producto
      const validProducts = ['cdtc_3m', 'cdtc_6m', 'cdtc_12m'];
      if (!validProducts.includes(productId)) {
        return res.status(400).json({ 
          error: `Producto no disponible. Usa: ${validProducts.join(', ')}` 
        });
      }

      // Validar monto mínimo
      if (amount < 100000) {
        return res.status(400).json({ error: 'Monto mínimo para CDTC: $100,000 COP' });
      }

      // Determinar duración según producto
      const durationMap = { cdtc_3m: 3, cdtc_6m: 6, cdtc_12m: 12 };
      const months = durationMap[productId];

      // Fechas
      const startDate = new Date();
      const lockEndDate = new Date(startDate);
      lockEndDate.setMonth(lockEndDate.getMonth() + months);

      // Crear inversión CDTC
      const result = await db.query(
        `INSERT INTO investments 
         (user_id, type, product_id, amount, net_capital, start_date, lock_end_date, 
          duration_months, status, created_at) 
         VALUES (?, 'cdtc', ?, ?, ?, ?, ?, ?, 'active', NOW())`,
        [userId, productId, amount, amount, startDate, lockEndDate, months]
      );

      // Descontar del balance
      await deductFromBalance(userId, amount, db);

      // Registrar transacción
      await db.query(
        `INSERT INTO transactions (user_id, type, amount, description, status, created_at) 
         VALUES (?, 'cdtc_investment', ?, ?, 'completed', NOW())`,
        [userId, amount, `Inversión CDTC ${months} meses`]
      );

      return res.json({
        success: true,
        message: 'Inversión CDTC creada exitosamente',
        investment: {
          id: result.insertId,
          type: 'cdtc',
          productId,
          amount,
          startDate,
          lockEndDate,
          durationMonths: months
        }
      });
    }

  } catch (error) {
    console.error('Error al crear inversión:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// =====================================================
// POST /investments/:id/withdraw-earnings
// Retirar ganancias del Pool (comisión 20%)
// =====================================================

router.post('/investments/:id/withdraw-earnings', async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const db = req.db;

  try {
    // Obtener la inversión
    const investments = await db.query(
      'SELECT * FROM investments WHERE id = ? AND user_id = ? AND type = "pool"',
      [id, userId]
    );

    if (!investments || investments.length === 0) {
      return res.status(404).json({ error: 'Inversión en Pool no encontrada' });
    }

    const investment = investments[0];
    const grossEarnings = parseFloat(investment.withdrawable_earnings) || 0;

    if (grossEarnings <= 0) {
      return res.status(400).json({ error: 'No hay ganancias disponibles para retirar' });
    }

    // Calcular comisión del 20%
    const commission = Math.round(grossEarnings * 0.20);
    const netAmount = grossEarnings - commission;

    // Actualizar la inversión (resetear ganancias retirables)
    await db.query(
      'UPDATE investments SET withdrawable_earnings = 0 WHERE id = ?',
      [id]
    );

    // Agregar el monto neto al balance del usuario
    await addToBalance(userId, netAmount, db);

    // Registrar el retiro en historial
    await db.query(
      `INSERT INTO pool_withdrawals (investment_id, user_id, gross_amount, commission, net_amount) 
       VALUES (?, ?, ?, ?, ?)`,
      [id, userId, grossEarnings, commission, netAmount]
    );

    // Registrar transacción
    await db.query(
      `INSERT INTO transactions (user_id, type, amount, description, status, created_at) 
       VALUES (?, 'pool_earnings_withdrawal', ?, ?, 'completed', NOW())`,
      [
        userId, 
        netAmount, 
        `Retiro de ganancias Pool (Bruto: $${grossEarnings.toLocaleString('es-CO')}, Comisión 20%: $${commission.toLocaleString('es-CO')})`
      ]
    );

    return res.json({
      success: true,
      message: 'Ganancias retiradas exitosamente',
      grossEarnings,
      commission,
      netAmount,
      newBalance: await getAvailableBalance(userId, db)
    });

  } catch (error) {
    console.error('Error al retirar ganancias:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// =====================================================
// GET /investments/pool-stats
// Obtener estadísticas y configuración del Pool
// =====================================================

router.get('/investments/pool-stats', async (req, res) => {
  const db = req.db;

  try {
    // Obtener configuración
    const config = await db.query('SELECT * FROM pool_config LIMIT 1');

    if (!config || config.length === 0) {
      // Valores por defecto
      return res.json({
        monthlyAPY: 2.0,
        annualAPY: 26.8,
        totalCapital: 0,
        distribution: 50,
        minAmount: 50000,
        monthsTracked: 0
      });
    }

    const poolConfig = config[0];

    // Obtener estadísticas reales de inversiones activas
    const stats = await db.query(
      `SELECT 
        COUNT(*) as active_count,
        COALESCE(SUM(amount), 0) as total_invested,
        COALESCE(SUM(net_capital), 0) as total_net_capital,
        COALESCE(SUM(entry_fee), 0) as total_fees,
        COALESCE(SUM(withdrawable_earnings), 0) as total_withdrawable
      FROM investments 
      WHERE type = 'pool' AND status = 'active'`
    );

    return res.json({
      monthlyAPY: parseFloat(poolConfig.monthly_apy),
      annualAPY: parseFloat(poolConfig.annual_apy),
      totalCapital: parseFloat(poolConfig.total_capital),
      distribution: parseInt(poolConfig.distribution),
      minAmount: parseFloat(poolConfig.min_amount),
      monthsTracked: parseInt(poolConfig.months_tracked),
      // Estadísticas en vivo
      stats: {
        activeInvestments: stats[0].active_count,
        totalInvested: parseFloat(stats[0].total_invested),
        totalNetCapital: parseFloat(stats[0].total_net_capital),
        totalFees: parseFloat(stats[0].total_fees),
        totalWithdrawable: parseFloat(stats[0].total_withdrawable)
      }
    });

  } catch (error) {
    console.error('Error al obtener pool stats:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// =====================================================
// POST /admin/pool/config
// Actualizar configuración del Pool (solo admin)
// =====================================================

router.post('/admin/pool/config', async (req, res) => {
  // Verificar que el usuario sea admin (ajusta según tu middleware)
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  const { monthlyAPY, annualAPY, totalCapital, distribution, minAmount } = req.body;
  const db = req.db;

  try {
    // Validaciones
    if (monthlyAPY <= 0 || monthlyAPY > 100) {
      return res.status(400).json({ error: 'APY mensual inválido (0-100)' });
    }
    if (distribution < 0 || distribution > 100) {
      return res.status(400).json({ error: 'Distribución inválida (0-100)' });
    }
    if (minAmount < 0) {
      return res.status(400).json({ error: 'Monto mínimo inválido' });
    }

    // Actualizar configuración
    await db.query(
      `UPDATE pool_config 
       SET monthly_apy = ?, annual_apy = ?, total_capital = ?, 
           distribution = ?, min_amount = ?, updated_at = NOW() 
       WHERE id = 1`,
      [monthlyAPY, annualAPY, totalCapital, distribution, minAmount]
    );

    return res.json({
      success: true,
      message: 'Configuración del Pool actualizada',
      config: { monthlyAPY, annualAPY, totalCapital, distribution, minAmount }
    });

  } catch (error) {
    console.error('Error al actualizar pool config:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// =====================================================
// GET /admin/investments/active
// Obtener inversiones activas (con filtro por tipo)
// =====================================================

router.get('/admin/investments/active', async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  const { type } = req.query; // 'pool' o 'cdtc'
  const db = req.db;

  try {
    let query = `
      SELECT 
        i.*,
        u.full_name as user_name,
        u.email as user_email,
        COALESCE(SUM(ir.earned), 0) as totalEarned
      FROM investments i
      JOIN users u ON i.user_id = u.id
      LEFT JOIN investment_returns ir ON i.id = ir.investment_id
      WHERE i.status IN ('active', 'pending_deposit')
    `;

    const params = [];

    if (type) {
      query += ' AND i.type = ?';
      params.push(type);
    }

    query += ' GROUP BY i.id ORDER BY i.created_at DESC';

    const investments = await db.query(query, params);

    return res.json(investments);

  } catch (error) {
    console.error('Error al obtener inversiones:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// =====================================================
// PROCESO MENSUAL: Registrar rendimientos del Pool
// (Ejecutar manualmente o con cron job)
// =====================================================

router.post('/admin/pool/pay-returns', async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  const { month, rate } = req.body; // Ejemplo: month='2024-04', rate=2.5
  const db = req.db;

  try {
    // Obtener todas las inversiones activas del pool
    const investments = await db.query(
      'SELECT * FROM investments WHERE type = "pool" AND status = "active"'
    );

    let totalPaid = 0;
    let count = 0;

    for (const inv of investments) {
      const netCapital = parseFloat(inv.net_capital);
      const monthlyReturn = Math.round(netCapital * (rate / 100));

      // Sumar a las ganancias retirables
      await db.query(
        'UPDATE investments SET withdrawable_earnings = withdrawable_earnings + ? WHERE id = ?',
        [monthlyReturn, inv.id]
      );

      // Registrar el rendimiento en investment_returns
      await db.query(
        `INSERT INTO investment_returns (investment_id, month, rate, earned, created_at) 
         VALUES (?, ?, ?, ?, NOW())`,
        [inv.id, month, rate, monthlyReturn]
      );

      totalPaid += monthlyReturn;
      count++;
    }

    // Incrementar meses rastreados
    await db.query(
      'UPDATE pool_config SET months_tracked = months_tracked + 1 WHERE id = 1'
    );

    return res.json({
      success: true,
      message: `Rendimientos del Pool pagados para ${month}`,
      monthsPaid: month,
      rate: rate,
      investmentsProcessed: count,
      totalPaid: totalPaid
    });

  } catch (error) {
    console.error('Error al pagar rendimientos del pool:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;