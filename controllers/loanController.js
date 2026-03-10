// ══════════════════════════════════════════════════════════════
// controllers/loanController.js — Sanse Capital
// FIXES:
//  1. Usa balanceHelper centralizado (elimina recalcBalance local)
//  2. Registra pagos en loan_payments para control de ganancias admin
//  3. Nuevos endpoints: adminGetLoanPayments, adminGetLoanProfitStats
// ══════════════════════════════════════════════════════════════
const { pool }   = require('../config/database');
const { notify } = require('../utils/telegram');
const { recalculateAndSaveBalance } = require('../utils/balanceHelper');

// ══════════════════════════════════════════════════════════════
// SISTEMA DE PUNTOS CREDITICIOS — "Sanse Score" (máx 1000 pts)
// ══════════════════════════════════════════════════════════════
async function calculateCreditScore(userId) {
    const points = { total: 0, breakdown: {} };

    // 1. Antigüedad de la cuenta (máx 150 pts)
    const [acctRows] = await pool.execute(`SELECT created_at FROM users WHERE id = ?`, [userId]);
    if (acctRows.length) {
        const monthsActive = Math.max(0, Math.round((Date.now() - new Date(acctRows[0].created_at)) / (1000 * 60 * 60 * 24 * 30)));
        const acctPts = Math.min(150, monthsActive * 15);
        points.breakdown.antiguedad = { pts: acctPts, max: 150, detail: `${monthsActive} meses activo` };
        points.total += acctPts;
    }

    // 2. Capital depositado total (máx 200 pts)
    const [depositRows] = await pool.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('deposit', 'payment')`, [userId]
    );
    const totalDeposited = parseFloat(depositRows[0].total);
    const depositPts = Math.min(200, Math.floor(totalDeposited / 500000) * 20);
    points.breakdown.capital = { pts: depositPts, max: 200, detail: `$${Math.round(totalDeposited).toLocaleString('es-CO')} depositados` };
    points.total += depositPts;

    // 3. Inversiones CDTC activas/completadas (máx 200 pts)
    const [invRows]     = await pool.execute(`SELECT COUNT(*) as active FROM investments WHERE user_id = ? AND status = 'active'`, [userId]);
    const [invCompRows] = await pool.execute(`SELECT COUNT(*) as completed FROM investments WHERE user_id = ? AND status = 'completed'`, [userId]);
    const activeInv    = parseInt(invRows[0].active);
    const completedInv = parseInt(invCompRows[0].completed);
    const invPts = Math.min(200, (activeInv * 50) + (completedInv * 30));
    points.breakdown.inversiones = { pts: invPts, max: 200, detail: `${activeInv} activas, ${completedInv} completadas` };
    points.total += invPts;

    // 4. Historial de préstamos (máx 250 pts)
    const [loanPaidRows] = await pool.execute(`SELECT COUNT(*) as paid FROM loan_requests WHERE user_id = ? AND status = 'paid'`, [userId]);
    const [loanLateRows] = await pool.execute(`SELECT COUNT(*) as late FROM loan_requests WHERE user_id = ? AND status = 'overdue'`, [userId]);
    const paidLoans = parseInt(loanPaidRows[0]?.paid || 0);
    const lateLoans = parseInt(loanLateRows[0]?.late || 0);
    const loanPts = Math.min(250, Math.max(0, (paidLoans * 80) - (lateLoans * 100)));
    points.breakdown.prestamos = { pts: loanPts, max: 250, detail: `${paidLoans} pagados, ${lateLoans} en mora` };
    points.total += loanPts;

    // 5. Actividad reciente — transacciones últimos 90 días (máx 100 pts)
    const [recentRows] = await pool.execute(
        `SELECT COUNT(*) as c FROM transactions WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)`, [userId]
    );
    const recentTx = parseInt(recentRows[0].c);
    const actPts = Math.min(100, recentTx * 10);
    points.breakdown.actividad = { pts: actPts, max: 100, detail: `${recentTx} transacciones (90 días)` };
    points.total += actPts;

    // 6. Balance actual (máx 100 pts)
    const [balRows] = await pool.execute(
        `SELECT amount FROM balance_history WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`, [userId]
    );
    const currentBalance = balRows.length ? parseFloat(balRows[0].amount) : 0;
    const balPts = Math.min(100, Math.floor(currentBalance / 1000000) * 20);
    points.breakdown.balance = { pts: balPts, max: 100, detail: `$${Math.round(currentBalance).toLocaleString('es-CO')} actual` };
    points.total += balPts;

    points.total = Math.min(1000, points.total);

    if      (points.total >= 800) points.tier = 'Platino';
    else if (points.total >= 600) points.tier = 'Oro';
    else if (points.total >= 400) points.tier = 'Plata';
    else if (points.total >= 200) points.tier = 'Bronce';
    else                          points.tier = 'Inicial';

    points.airdropMultiplier = parseFloat((points.total / 1000 * 5).toFixed(2));
    return points;
}

// ══════════════════════════════════════════════════════════════
// GET /api/loans/my
// ══════════════════════════════════════════════════════════════
exports.getMyLoans = async (req, res) => {
    try {
        const userId = req.user.id;
        let legacyLoans = [];
        try {
            const [rows] = await pool.execute(
                `SELECT id, amount, monthly_rate, start_date, status, created_at FROM loans WHERE user_id = ? ORDER BY created_at DESC`, [userId]
            );
            legacyLoans = rows.map(l => ({
                id: l.id, source: 'legacy', amount: parseFloat(l.amount),
                monthlyRate: parseFloat(l.monthly_rate), startDate: l.start_date,
                status: l.status, createdAt: l.created_at,
            }));
        } catch (e) {}

        let loanRequests = [];
        try {
            const [rows] = await pool.execute(`SELECT * FROM loan_requests WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
            loanRequests = rows.map(l => ({
                id: l.id, source: 'request', amount: parseFloat(l.amount),
                monthlyRate: parseFloat(l.monthly_rate || 0), term: l.term_months,
                purpose: l.purpose, status: l.status, adminNotes: l.admin_notes,
                approvedAmount: l.approved_amount !== null && l.approved_amount !== undefined
                    ? parseFloat(l.approved_amount)
                    : null,
                approvedRate: l.approved_rate ? parseFloat(l.approved_rate) : null,
                startDate: l.start_date, dueDate: l.due_date,
                createdAt: l.created_at, processedAt: l.processed_at,
            }));
        } catch (e) {}

        res.json({ legacyLoans, loanRequests });
    } catch (error) {
        console.error('Error obteniendo préstamos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// GET /api/loans/credit-score
// ══════════════════════════════════════════════════════════════
exports.getCreditScore = async (req, res) => {
    try {
        const score = await calculateCreditScore(req.user.id);
        res.json(score);
    } catch (error) {
        console.error('Error calculando credit score:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// POST /api/loans/request
// ══════════════════════════════════════════════════════════════
exports.requestLoan = async (req, res) => {
    try {
        const userId = req.user.id;
        const amount = parseFloat(req.body.amount);
        const { termMonths, purpose } = req.body;

        if (!amount || isNaN(amount) || !isFinite(amount) || amount < 100000)
            return res.status(400).json({ error: 'Monto mínimo de préstamo: $100.000 COP' });
        if (amount > 10000000)
            return res.status(400).json({ error: 'Monto máximo de préstamo: $10.000.000 COP' });
        if (!termMonths || ![1, 2, 3, 6].includes(parseInt(termMonths)))
            return res.status(400).json({ error: 'Plazo debe ser 1, 2, 3 o 6 meses' });

        try {
            const [existing] = await pool.execute(
                `SELECT COUNT(*) as c FROM loan_requests WHERE user_id = ? AND status IN ('pending', 'active')`, [userId]
            );
            if (existing[0].c > 0)
                return res.status(400).json({ error: 'Ya tienes una solicitud pendiente o un préstamo activo.' });
        } catch (e) {}

        const score = await calculateCreditScore(userId);

        const refId = 'LOAN-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        const [result] = await pool.execute(
            `INSERT INTO loan_requests (user_id, amount, term_months, purpose, credit_score, status, ref_id) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
            [userId, amount, parseInt(termMonths), purpose || null, score.total, refId]
        );

        const [userRows] = await pool.execute(`SELECT full_name, email FROM users WHERE id = ?`, [userId]);
        const userName  = userRows.length ? userRows[0].full_name : 'Usuario';
        const userEmail = userRows.length ? userRows[0].email : '';

        await notify(
            `🏦 *SOLICITUD DE PRÉSTAMO — Sanse Capital*\n\n` +
            `👤 *${userName}*\n📧 ${userEmail}\n` +
            `💰 *$${Math.round(amount).toLocaleString('es-CO')} COP*\n` +
            `📅 Plazo: ${termMonths} meses\n` +
            `📝 Propósito: ${purpose || 'No especificado'}\n` +
            `⭐ Sanse Score: ${score.total}/1000 (${score.tier})\n` +
            `🔖 Ref: ${refId}\n\n` +
            `➡️ Revisa en el panel admin para aprobar o rechazar.`
        );

        res.status(201).json({
            message: 'Solicitud de préstamo creada. Será revisada en las próximas 24-48 horas.',
            loan: { id: result.insertId, refId, amount, termMonths: parseInt(termMonths), creditScore: score.total, tier: score.tier },
        });
    } catch (error) {
        console.error('Error solicitando préstamo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: GET /api/admin/loans
// ══════════════════════════════════════════════════════════════
exports.adminGetLoans = async (req, res) => {
    try {
        const status = req.query.status || 'all';
        let query = `SELECT lr.*, u.full_name as user_name, u.email as user_email, u.phone as user_phone, u.document_number
                     FROM loan_requests lr LEFT JOIN users u ON lr.user_id = u.id`;
        const params = [];
        if (status !== 'all') { query += ` WHERE lr.status = ?`; params.push(status); }
        query += ` ORDER BY lr.created_at DESC LIMIT 50`;

        const [rows] = await pool.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error obteniendo préstamos admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: POST /api/admin/loans/:id/process
// FIX: Usa balanceHelper centralizado
// ══════════════════════════════════════════════════════════════
exports.adminProcessLoan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const loanId = req.params.id;
        const { action, approvedAmount, approvedRate, notes } = req.body;

        if (!['approve', 'reject', 'mark_paid', 'mark_overdue'].includes(action)) {
            return res.status(400).json({ error: 'Acción inválida. Usar: approve, reject, mark_paid, mark_overdue' });
        }

        const [loanRows] = await connection.execute(`SELECT * FROM loan_requests WHERE id = ?`, [loanId]);
        if (!loanRows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
        const loan = loanRows[0];

        if (action === 'approve') {
            if (loan.status !== 'pending') return res.status(400).json({ error: 'Solo se pueden aprobar solicitudes pendientes' });

            const finalAmount = approvedAmount ? parseFloat(approvedAmount) : parseFloat(loan.amount);
            let defaultRate = 6.0;
            const [investorCheck] = await connection.execute(`SELECT COUNT(*) as c FROM investments WHERE user_id = ?`, [loan.user_id]);
            if (parseInt(investorCheck[0].c) > 0) defaultRate = 4.0;
            const finalRate = approvedRate ? parseFloat(approvedRate) : defaultRate;

            const startDate = new Date();
            const dueDate   = new Date();
            dueDate.setMonth(dueDate.getMonth() + parseInt(loan.term_months));

            await connection.execute(
                `UPDATE loan_requests SET status = 'active', approved_amount = ?, approved_rate = ?, monthly_rate = ?,
                 start_date = ?, due_date = ?, admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [finalAmount, finalRate, finalRate, startDate.toISOString().slice(0, 10), dueDate.toISOString().slice(0, 10), notes || null, req.user.id, loanId]
            );

            const refId = 'LN-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'loan', ?, ?, ?, NOW())`,
                [loan.user_id, finalAmount, `Préstamo aprobado — ${loan.term_months} meses al ${finalRate}% mensual — Ref: ${loan.ref_id}`, refId]
            );

            // FIX: Usa balanceHelper centralizado
            const newBalance = await recalculateAndSaveBalance(connection, loan.user_id);

            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [loan.user_id]);
            await notify(
                `✅ *PRÉSTAMO APROBADO*\n\n👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                `💰 $${Math.round(finalAmount).toLocaleString('es-CO')}\n📅 ${loan.term_months} meses al ${finalRate}%\n🔖 ${loan.ref_id}`
            );

        } else if (action === 'reject') {
            if (loan.status !== 'pending') return res.status(400).json({ error: 'Solo se pueden rechazar solicitudes pendientes' });
            await connection.execute(
                `UPDATE loan_requests SET status = 'rejected', admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || 'Rechazado por el administrador', req.user.id, loanId]
            );

        } else if (action === 'mark_paid') {
            if (loan.status !== 'active' && loan.status !== 'overdue')
                return res.status(400).json({ error: 'Solo préstamos activos o en mora' });
            const paidNote = `PAGADO: ${new Date().toISOString().slice(0, 10)}`;
            await connection.execute(
                `UPDATE loan_requests SET status = 'paid', approved_amount = 0, admin_notes = CONCAT(IFNULL(admin_notes,''), ?), processed_at = NOW() WHERE id = ?`,
                [` | ${paidNote}`, loanId]
            );

        } else if (action === 'mark_overdue') {
            if (loan.status !== 'active') return res.status(400).json({ error: 'Solo préstamos activos' });
            const overdueNote = `MORA: ${notes || ''}`;
            await connection.execute(
                `UPDATE loan_requests SET status = 'overdue', admin_notes = CONCAT(IFNULL(admin_notes,''), ?) WHERE id = ?`,
                [` | ${overdueNote}`, loanId]
            );
        }

        await connection.commit();
        const statusLabels = { approve: 'aprobada', reject: 'rechazada', mark_paid: 'marcada como pagada', mark_overdue: 'marcada en mora' };
        res.json({ message: `Solicitud ${statusLabels[action]}` });
    } catch (error) {
        await connection.rollback();
        console.error('Error procesando préstamo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ADMIN: GET credit score de cualquier usuario
exports.adminGetCreditScore = async (req, res) => {
    try {
        const score = await calculateCreditScore(req.params.userId);
        res.json(score);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// POST /api/loans/pay — Abonar a un préstamo
// FIX: Usa balanceHelper centralizado
// NUEVO: Registra en loan_payments para control de ganancias
// ══════════════════════════════════════════════════════════════
exports.payLoan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const { loanId, amount: rawAmount } = req.body;
        const amount = parseFloat(rawAmount);

        if (!loanId || !amount || isNaN(amount) || amount < 1000)
            return res.status(400).json({ error: 'Monto mínimo de abono: $1.000 COP' });

        const [loanRows] = await connection.execute(
            `SELECT * FROM loan_requests WHERE id = ? AND user_id = ? AND status IN ('active', 'overdue')`,
            [loanId, userId]
        );
        if (!loanRows.length) return res.status(404).json({ error: 'Préstamo no encontrado o no está activo' });
        const loan = loanRows[0];

        const originalCapital = parseFloat(loan.amount);
        const pendingCapital  = (loan.approved_amount !== null && loan.approved_amount !== undefined)
            ? parseFloat(loan.approved_amount)
            : originalCapital;
        const loanRate = parseFloat(loan.approved_rate || loan.monthly_rate || 4);

        const monthlyInterest = Math.round(pendingCapital * (loanRate / 100));

        // Balance disponible del usuario
        const [balanceRows] = await connection.execute(
            `SELECT amount FROM balance_history WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`, [userId]
        );
        const currentBalance = balanceRows.length ? parseFloat(balanceRows[0].amount) : 0;
        const [investedRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit')`, [userId]
        );
        const [pendingWR] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`, [userId]
        );
        const availableBalance = currentBalance - parseFloat(investedRows[0].total) - parseFloat(pendingWR[0].total);

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Saldo disponible insuficiente. Disponible: $${Math.round(Math.max(0, availableBalance)).toLocaleString('es-CO')} COP`,
                available: Math.max(0, availableBalance),
            });
        }

        const interestCovered = Math.min(amount, monthlyInterest);
        const capitalReduced  = Math.max(0, amount - interestCovered);
        const newPendingCapital = Math.max(0, pendingCapital - capitalReduced);
        const isFullyPaid = newPendingCapital <= 0;

        // Comisión de referido (5% de los intereses cubiertos)
        let referralCommission = 0;
        let referrerId = null;
        const [refCheck] = await connection.execute('SELECT referred_by FROM users WHERE id = ?', [userId]);
        if (refCheck.length && refCheck[0].referred_by && interestCovered > 0) {
            referrerId         = refCheck[0].referred_by;
            referralCommission = Math.round(interestCovered * 0.05);
        }

        // Registrar transacción de abono
        const refId = 'PAY-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        await connection.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'withdraw', ?, ?, ?, NOW())`,
            [userId, amount,
             `Abono préstamo ${loan.ref_id} — Intereses: $${Math.round(interestCovered).toLocaleString('es-CO')} | Capital: $${Math.round(capitalReduced).toLocaleString('es-CO')} | Pendiente: $${Math.round(newPendingCapital).toLocaleString('es-CO')}`,
             refId]
        );

        // ── NUEVO: Registrar en loan_payments para control de ganancias admin ──
        await connection.execute(
            `INSERT INTO loan_payments (loan_id, user_id, amount, interest_amount, capital_amount, remaining_capital, loan_rate, ref_id, is_fully_paid, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [loanId, userId, amount, interestCovered, capitalReduced, newPendingCapital, loanRate, refId, isFullyPaid ? 1 : 0]
        );

        // Comisión al referidor
        if (referrerId && referralCommission >= 100) {
            const referralRefId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            try {
                await connection.execute(
                    `INSERT INTO referral_commissions (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id)
                     VALUES (?, ?, 'loan_interest', ?, ?, 0.05, ?, 'paid', ?)`,
                    [referrerId, userId, loanId, interestCovered, referralCommission, referralRefId]
                );
            } catch (e) { console.error('Error registrando comisión referido préstamo:', e.message); }

            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'profit', ?, ?, ?, NOW())`,
                [referrerId, referralCommission, `Comisión referido — 5% intereses préstamo`, referralRefId]
            );
        }

        // Actualizar préstamo
        const abonoNote = ` | ABONO $${Math.round(amount).toLocaleString('es-CO')} ${new Date().toISOString().slice(0, 10)} ref:${refId} (interes:$${Math.round(interestCovered).toLocaleString('es-CO')} capital:$${Math.round(capitalReduced).toLocaleString('es-CO')})`;
        if (isFullyPaid) {
            await connection.execute(
                `UPDATE loan_requests SET approved_amount = 0, status = 'paid',
                 admin_notes = CONCAT(IFNULL(admin_notes,''), ?), processed_at = NOW() WHERE id = ?`,
                [abonoNote + ' | PAGADO COMPLETO', loanId]
            );
        } else {
            await connection.execute(
                `UPDATE loan_requests SET approved_amount = ?,
                 admin_notes = CONCAT(IFNULL(admin_notes,''), ?) WHERE id = ?`,
                [newPendingCapital, abonoNote, loanId]
            );
        }

        // FIX: Usa balanceHelper centralizado
        const newBalance = await recalculateAndSaveBalance(connection, userId);

        if (referrerId && referralCommission >= 100) {
            await recalculateAndSaveBalance(connection, referrerId);
        }

        await connection.commit();

        const [userRows] = await pool.execute(`SELECT full_name FROM users WHERE id = ?`, [userId]);
        await notify(
            `💳 *ABONO A PRÉSTAMO — Sanse Capital*\n\n` +
            `👤 *${userRows[0]?.full_name || 'Usuario'}*\n` +
            `💰 Abono: *$${Math.round(amount).toLocaleString('es-CO')} COP*\n` +
            `📊 Intereses cubiertos: $${Math.round(interestCovered).toLocaleString('es-CO')}\n` +
            `📉 Capital reducido: $${Math.round(capitalReduced).toLocaleString('es-CO')}\n` +
            `🏦 Capital pendiente: $${Math.round(newPendingCapital).toLocaleString('es-CO')} COP\n` +
            `${isFullyPaid ? '✅ *PRÉSTAMO PAGADO COMPLETAMENTE*\n' : ''}` +
            `🔖 Ref abono: ${refId}`
        );

        res.json({
            message: isFullyPaid ? '¡Préstamo pagado completamente! 🎉' : 'Abono registrado exitosamente',
            payment: {
                amount,
                interestCovered,
                capitalReduced,
                refId,
                newBalance,
                remainingCapital: newPendingCapital,
                isFullyPaid,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error abonando préstamo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: GET /api/admin/loans/payments — Todos los pagos de préstamos
// ══════════════════════════════════════════════════════════════
exports.adminGetLoanPayments = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT lp.*, 
                    u.full_name as user_name, 
                    u.email as user_email,
                    lr.ref_id as loan_ref_id,
                    lr.amount as loan_original_amount,
                    lr.term_months as loan_term,
                    lr.status as loan_status
             FROM loan_payments lp
             LEFT JOIN users u ON lp.user_id = u.id
             LEFT JOIN loan_requests lr ON lp.loan_id = lr.id
             ORDER BY lp.created_at DESC
             LIMIT 200`
        );
        res.json(rows);
    } catch (error) {
        console.error('Error obteniendo pagos de préstamos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: GET /api/admin/loans/profit-stats — KPIs de ganancias
// ══════════════════════════════════════════════════════════════
exports.adminGetLoanProfitStats = async (req, res) => {
    try {
        const [totalRows] = await pool.execute(
            `SELECT COALESCE(SUM(interest_amount), 0) as totalInterestEarned,
                    COALESCE(SUM(capital_amount), 0) as totalCapitalRecovered,
                    COALESCE(SUM(amount), 0) as totalPaymentsReceived,
                    COUNT(*) as totalPaymentCount
             FROM loan_payments`
        );

        const [monthRows] = await pool.execute(
            `SELECT COALESCE(SUM(interest_amount), 0) as monthInterest,
                    COALESCE(SUM(capital_amount), 0) as monthCapital,
                    COALESCE(SUM(amount), 0) as monthTotal,
                    COUNT(*) as monthCount
             FROM loan_payments
             WHERE MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())`
        );

        const [activeRows] = await pool.execute(
            `SELECT COALESCE(SUM(approved_amount), 0) as activeLoanCapital,
                    COUNT(*) as activeLoanCount
             FROM loan_requests
             WHERE status IN ('active', 'overdue') AND approved_amount > 0`
        );

        const [paidRows] = await pool.execute(
            `SELECT COUNT(*) as paidLoanCount FROM loan_requests WHERE status = 'paid'`
        );

        const [overdueRows] = await pool.execute(
            `SELECT COUNT(*) as overdueLoanCount,
                    COALESCE(SUM(approved_amount), 0) as overdueCapital
             FROM loan_requests WHERE status = 'overdue'`
        );

        const [avgRateRows] = await pool.execute(
            `SELECT COALESCE(
                SUM(loan_rate * amount) / NULLIF(SUM(amount), 0), 0
             ) as weightedAvgRate
             FROM loan_payments WHERE loan_rate > 0`
        );

        res.json({
            totalInterestEarned:   parseFloat(totalRows[0].totalInterestEarned),
            totalCapitalRecovered: parseFloat(totalRows[0].totalCapitalRecovered),
            totalPaymentsReceived: parseFloat(totalRows[0].totalPaymentsReceived),
            totalPaymentCount:     parseInt(totalRows[0].totalPaymentCount),
            monthInterest: parseFloat(monthRows[0].monthInterest),
            monthCapital:  parseFloat(monthRows[0].monthCapital),
            monthTotal:    parseFloat(monthRows[0].monthTotal),
            monthCount:    parseInt(monthRows[0].monthCount),
            activeLoanCapital: parseFloat(activeRows[0].activeLoanCapital),
            activeLoanCount:   parseInt(activeRows[0].activeLoanCount),
            paidLoanCount:    parseInt(paidRows[0].paidLoanCount),
            overdueLoanCount: parseInt(overdueRows[0].overdueLoanCount),
            overdueCapital:   parseFloat(overdueRows[0].overdueCapital),
            weightedAvgRate: parseFloat(parseFloat(avgRateRows[0].weightedAvgRate).toFixed(2)),
        });
    } catch (error) {
        console.error('Error stats ganancias préstamos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};