// ══════════════════════════════════════════════════════════════
// controllers/loanController.js — Sanse Capital
// FIXES:
//  1. Usa balanceHelper centralizado (elimina recalcBalance local)
//  2. Registra pagos en loan_payments para control de ganancias admin
//  3. Nuevos endpoints: adminGetLoanPayments, adminGetLoanProfitStats
//  4. ★ payLoan: lógica PRORRATEADA — el interés se cobra solo por el
//     tiempo transcurrido desde la última fecha de corte (start_date o
//     último pago). Si el abono es menor al interés acumulado, el
//     restante se CAPITALIZA (se suma al capital pendiente).
// ══════════════════════════════════════════════════════════════
const { pool }   = require('../config/database');
const { notify } = require('../utils/telegram');
const { recalculateAndSaveBalance } = require('../utils/balanceHelper');

const SECONDS_PER_MONTH = 30 * 24 * 60 * 60; // mismo divisor que el frontend (30 días)

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
            // FIX: Trae last_payment_at por subquery para que el frontend pueda
            //      calcular el interés en vivo desde el último abono (no desde el inicio)
            const [rows] = await pool.execute(
                `SELECT lr.*,
                        (SELECT MAX(created_at) FROM loan_payments WHERE loan_id = lr.id) AS last_payment_at
                 FROM loan_requests lr
                 WHERE lr.user_id = ?
                 ORDER BY lr.created_at DESC`,
                [userId]
            );

            // NUEVO: Trae historial de pagos solo de préstamos activos/en mora
            const activeIds = rows
                .filter(l => ['active', 'overdue'].includes(l.status))
                .map(l => l.id);

            let paymentsByLoan = {};
            if (activeIds.length) {
                const placeholders = activeIds.map(() => '?').join(',');
                const [payments] = await pool.execute(
                    `SELECT id, loan_id, amount, interest_amount, capital_amount, remaining_capital,
                            ref_id, is_fully_paid, created_at
                     FROM loan_payments
                     WHERE loan_id IN (${placeholders})
                     ORDER BY created_at DESC`,
                    activeIds
                );
                paymentsByLoan = payments.reduce((acc, p) => {
                    if (!acc[p.loan_id]) acc[p.loan_id] = [];
                    acc[p.loan_id].push({
                        id: p.id,
                        amount: parseFloat(p.amount),
                        interestAmount: parseFloat(p.interest_amount),
                        capitalAmount: parseFloat(p.capital_amount),
                        remainingCapital: parseFloat(p.remaining_capital),
                        refId: p.ref_id,
                        isFullyPaid: !!p.is_fully_paid,
                        createdAt: p.created_at,
                    });
                    return acc;
                }, {});
            }

            loanRequests = rows.map(l => ({
                id: l.id,
                source: 'request',
                amount: parseFloat(l.amount),
                monthlyRate: parseFloat(l.monthly_rate || 0),
                term: l.term_months,                            // puede ser null = indefinido
                indefinite: l.term_months === null,             // NUEVO: flag explícito
                purpose: l.purpose,
                status: l.status,
                adminNotes: l.admin_notes,
                approvedAmount: l.approved_amount !== null && l.approved_amount !== undefined
                    ? parseFloat(l.approved_amount)
                    : null,
                approvedRate: l.approved_rate ? parseFloat(l.approved_rate) : null,
                startDate: l.start_date,
                dueDate: l.due_date,                            // puede ser null = sin vencimiento
                lastPaymentAt: l.last_payment_at,               // NUEVO: para tick en vivo
                payments: paymentsByLoan[l.id] || [],           // NUEVO: historial de abonos
                createdAt: l.created_at,
                processedAt: l.processed_at,
            }));
        } catch (e) { console.error('Error en getMyLoans loanRequests:', e); }

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
// ══════════════════════════════════════════════════════════════
exports.adminProcessLoan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const loanId = req.params.id;
        const { action, approvedAmount, approvedRate, notes } = req.body;

        if (!['approve', 'reject', 'mark_paid', 'mark_overdue', 'cancel', 'edit_term'].includes(action)) {
            return res.status(400).json({ error: 'Acción inválida. Usar: approve, reject, mark_paid, mark_overdue, cancel, edit_term' });
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

        } else if (action === 'cancel') {
            // ★ NUEVO: Cancelación SUAVE de un préstamo activo o en mora
            // - Marca status = 'cancelled'
            // - NO toca el balance del usuario (el dinero ya se gastó / no se cobra lo pendiente)
            // - El historial de abonos y transacciones queda intacto
            if (loan.status !== 'active' && loan.status !== 'overdue') {
                return res.status(400).json({ error: 'Solo se pueden cancelar préstamos activos o en mora' });
            }
            const cancelNote = `CANCELADO: ${new Date().toISOString().slice(0, 10)}${notes ? ' — ' + notes : ''}`;
            await connection.execute(
                `UPDATE loan_requests SET status = 'cancelled',
                 admin_notes = CONCAT(IFNULL(admin_notes,''), ?), processed_at = NOW(), processed_by = ?
                 WHERE id = ?`,
                [` | ${cancelNote}`, req.user.id, loanId]
            );

            // Notificación a Telegram
            try {
                const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [loan.user_id]);
                await notify(
                    `🚫 *PRÉSTAMO CANCELADO*\n\n` +
                    `👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                    `💰 Capital pendiente: $${Math.round(parseFloat(loan.approved_amount || loan.amount)).toLocaleString('es-CO')}\n` +
                    `📌 El balance del usuario NO se modificó\n` +
                    `🔖 ${loan.ref_id}` +
                    `${notes ? '\n📝 ' + notes : ''}`
                );
            } catch (e) { /* notify es best-effort */ }
        } else if (action === 'edit_term') {
            // ★ NUEVO: Editar el plazo de un préstamo activo / en mora
            // - Solo cambia term_months y recalcula due_date
            // - NO toca capital, abonos, tasa ni status
            if (loan.status !== 'active' && loan.status !== 'overdue') {
                return res.status(400).json({ error: 'Solo se puede editar el plazo de préstamos activos o en mora' });
            }
            const newTerm = parseInt(req.body.newTermMonths);
            if (isNaN(newTerm) || newTerm < 0 || newTerm > 120) {
                return res.status(400).json({ error: 'Plazo inválido (0–120 meses, 0 = sin plazo)' });
            }

            // newTerm = 0 → "sin plazo definido" (NULL en ambos campos)
            let newDueDate = null;
            let newTermVal = null;
            if (newTerm > 0) {
                newTermVal = newTerm;
                const startDate = loan.start_date ? new Date(loan.start_date) : new Date();
                const due = new Date(startDate);
                due.setMonth(due.getMonth() + newTerm);
                newDueDate = due.toISOString().slice(0, 10);
            }

            const editNote = `EDIT PLAZO: ${loan.term_months != null ? loan.term_months + 'm' : 'sin plazo'} → ${newTerm === 0 ? 'sin plazo' : newTerm + 'm'} (${new Date().toISOString().slice(0, 10)})`;
            await connection.execute(
                `UPDATE loan_requests
                 SET term_months = ?, due_date = ?, admin_notes = CONCAT(IFNULL(admin_notes,''), ?)
                 WHERE id = ?`,
                [newTermVal, newDueDate, ` | ${editNote}`, loanId]
            );

            // Notificación a Telegram (best-effort)
            try {
                const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [loan.user_id]);
                await notify(
                    `📅 *PLAZO EDITADO*\n\n` +
                    `👤 ${userRows[0]?.full_name || 'Usuario'}\n` +
                    `🔖 ${loan.ref_id}\n` +
                    `Plazo: ${loan.term_months != null ? loan.term_months + ' meses' : 'sin plazo'} → *${newTerm === 0 ? 'sin plazo' : newTerm + ' meses'}*` +
                    (newDueDate ? `\n📌 Nuevo vencimiento: ${newDueDate}` : '')
                );
            } catch (e) { /* notify es best-effort */ }
        }

        await connection.commit();
        const statusLabels = {
            approve: 'aprobada',
            reject: 'rechazada',
            mark_paid: 'marcada como pagada',
            mark_overdue: 'marcada en mora',
            cancel: 'cancelada',
            edit_term: 'editada (plazo actualizado)'
        };
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
// ★ POST /api/loans/pay — Abonar a un préstamo (LÓGICA PRORRATEADA)
//
// CAMBIO PRINCIPAL vs. versión anterior:
//   - Antes: cobraba siempre `capital × rate/100` (UN MES ENTERO de interés)
//   - Ahora: cobra solo el interés ACUMULADO desde la última fecha de corte,
//     prorrateado al segundo (igual que el frontend muestra en vivo).
//
// FECHA DE CORTE = max(start_date_del_préstamo, fecha_último_pago)
//
// CAPITALIZACIÓN:
//   - Si abono >= interés acumulado → cubre todo el interés, sobrante a capital
//   - Si abono <  interés acumulado → cubre lo que pueda; el restante se SUMA
//     al capital pendiente (interés capitalizado → genera interés desde ahora)
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

        // ─── Determinar fecha de corte (último pago O inicio del préstamo) ───
        let cutoffDate = loan.start_date ? new Date(loan.start_date) : new Date(loan.created_at);
        try {
            const [lastPay] = await connection.execute(
                `SELECT created_at FROM loan_payments WHERE loan_id = ? ORDER BY created_at DESC LIMIT 1`,
                [loanId]
            );
            if (lastPay.length) {
                cutoffDate = new Date(lastPay[0].created_at);
            }
        } catch (e) {
            // si la tabla loan_payments no existe aún, usar start_date como corte
        }

        const now = new Date();
        const secondsElapsed = Math.max(0, (now - cutoffDate) / 1000);

        // ─── Interés acumulado real (prorrateado al segundo) ───
        const interestAccrued = Math.round(
            pendingCapital * (loanRate / 100) * (secondsElapsed / SECONDS_PER_MONTH)
        );

        // ─── Cálculo del abono ───
        let interestCovered, capitalReduced, newPendingCapital;

        if (amount >= interestAccrued) {
            // Caso A: alcanza para cubrir todo el interés → resto va a capital
            interestCovered    = interestAccrued;
            capitalReduced     = Math.max(0, amount - interestCovered);
            newPendingCapital  = Math.max(0, pendingCapital - capitalReduced);
        } else {
            // Caso B (capitalización): abono no cubre el interés
            //   - todo el abono se considera "interés cubierto"
            //   - el interés NO cubierto se suma al capital pendiente
            interestCovered    = amount;
            const interestUncovered = interestAccrued - amount;
            capitalReduced     = 0;
            newPendingCapital  = pendingCapital + interestUncovered;
        }

        const isFullyPaid = newPendingCapital <= 0;

        // ─── Validar balance disponible ───
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

        // ─── Comisión de referido (5% de intereses cubiertos) ───
        let referralCommission = 0;
        let referrerId = null;
        const [refCheck] = await connection.execute('SELECT referred_by FROM users WHERE id = ?', [userId]);
        if (refCheck.length && refCheck[0].referred_by && interestCovered > 0) {
            referrerId         = refCheck[0].referred_by;
            referralCommission = Math.round(interestCovered * 0.05);
        }

        // ─── Registrar transacción de abono ───
        const refId = 'PAY-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
        const capitalizedNote = (amount < interestAccrued)
            ? ` | Capitalizado: $${Math.round(interestAccrued - amount).toLocaleString('es-CO')}`
            : '';
        await connection.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'withdraw', ?, ?, ?, NOW())`,
            [userId, amount,
             `Abono préstamo ${loan.ref_id} — Intereses: $${Math.round(interestCovered).toLocaleString('es-CO')} | Capital: $${Math.round(capitalReduced).toLocaleString('es-CO')} | Pendiente: $${Math.round(newPendingCapital).toLocaleString('es-CO')}${capitalizedNote}`,
             refId]
        );

        // ─── Registrar en loan_payments ───
        await connection.execute(
            `INSERT INTO loan_payments (loan_id, user_id, amount, interest_amount, capital_amount, remaining_capital, loan_rate, ref_id, is_fully_paid, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [loanId, userId, amount, interestCovered, capitalReduced, newPendingCapital, loanRate, refId, isFullyPaid ? 1 : 0]
        );

        // ─── Comisión al referidor ───
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

        // ─── Actualizar préstamo ───
        const daysElapsed = Math.floor(secondsElapsed / 86400);
        const abonoNote = ` | ABONO $${Math.round(amount).toLocaleString('es-CO')} ${now.toISOString().slice(0, 10)} ref:${refId} (${daysElapsed}d, interes:$${Math.round(interestCovered).toLocaleString('es-CO')} capital:$${Math.round(capitalReduced).toLocaleString('es-CO')}${capitalizedNote})`;

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
            `📊 Intereses (${daysElapsed}d): $${Math.round(interestAccrued).toLocaleString('es-CO')}\n` +
            `   └ Cubiertos: $${Math.round(interestCovered).toLocaleString('es-CO')}\n` +
            `📉 Capital reducido: $${Math.round(capitalReduced).toLocaleString('es-CO')}\n` +
            `🏦 Capital pendiente: $${Math.round(newPendingCapital).toLocaleString('es-CO')} COP\n` +
            `${(amount < interestAccrued) ? `⚠️ Interés capitalizado: $${Math.round(interestAccrued - amount).toLocaleString('es-CO')}\n` : ''}` +
            `${isFullyPaid ? '✅ *PRÉSTAMO PAGADO COMPLETAMENTE*\n' : ''}` +
            `🔖 Ref abono: ${refId}`
        );

        res.json({
            message: isFullyPaid ? '¡Préstamo pagado completamente! 🎉' : 'Abono registrado exitosamente',
            payment: {
                amount,
                interestAccrued,         // lo que se acumuló desde el último corte
                interestCovered,         // lo que efectivamente cubrió este abono
                interestCapitalized: Math.max(0, interestAccrued - amount), // lo que se sumó al capital
                capitalReduced,
                daysElapsed,
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
// ADMIN: POST /api/admin/loans/:id/payment
// Registra un ABONO EXTERNO (el cliente pagó por fuera: efectivo,
// transferencia, etc.). NO toca el balance del cliente en la plataforma.
// Misma lógica prorrateada que payLoan: cubre interés primero, lo que
// sobra baja capital, y si no alcanza, capitaliza. Reinicia el reloj.
// Body: { amount, notes? }
// ══════════════════════════════════════════════════════════════
exports.adminLoanPayment = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const loanId = req.params.id;
        const { amount: rawAmount, notes } = req.body;
        const amount = parseFloat(rawAmount);

        if (!loanId || !amount || isNaN(amount) || amount < 1000) {
            await connection.rollback();
            return res.status(400).json({ error: 'Monto mínimo de abono: $1.000 COP' });
        }

        const [loanRows] = await connection.execute(
            `SELECT * FROM loan_requests WHERE id = ? AND status IN ('active', 'overdue')`,
            [loanId]
        );
        if (!loanRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Préstamo no encontrado o no está activo' });
        }
        const loan = loanRows[0];
        const userId = loan.user_id;

        const originalCapital = parseFloat(loan.amount);
        const pendingCapital  = (loan.approved_amount !== null && loan.approved_amount !== undefined)
            ? parseFloat(loan.approved_amount)
            : originalCapital;
        const loanRate = parseFloat(loan.approved_rate || loan.monthly_rate || 4);

        // ─── Fecha de corte (último pago O inicio del préstamo) ───
        let cutoffDate = loan.start_date ? new Date(loan.start_date) : new Date(loan.created_at);
        try {
            const [lastPay] = await connection.execute(
                `SELECT created_at FROM loan_payments WHERE loan_id = ? ORDER BY created_at DESC LIMIT 1`,
                [loanId]
            );
            if (lastPay.length) cutoffDate = new Date(lastPay[0].created_at);
        } catch (e) {}

        const now = new Date();
        const secondsElapsed = Math.max(0, (now - cutoffDate) / 1000);

        // ─── Interés acumulado real (prorrateado) ───
        const interestAccrued = Math.round(
            pendingCapital * (loanRate / 100) * (secondsElapsed / SECONDS_PER_MONTH)
        );

        // ─── Cálculo del abono (interés primero, resto a capital; si no alcanza, capitaliza) ───
        let interestCovered, capitalReduced, newPendingCapital;
        if (amount >= interestAccrued) {
            interestCovered   = interestAccrued;
            capitalReduced    = Math.max(0, amount - interestCovered);
            newPendingCapital = Math.max(0, pendingCapital - capitalReduced);
        } else {
            interestCovered   = amount;
            const interestUncovered = interestAccrued - amount;
            capitalReduced    = 0;
            newPendingCapital = pendingCapital + interestUncovered;
        }
        const isFullyPaid = newPendingCapital <= 0;

        // NOTA: abono EXTERNO → NO se valida ni descuenta balance del cliente,
        // y NO se crea transacción 'withdraw'. Solo se registra el pago.

        // ─── Comisión de referido (5% de intereses cubiertos) ───
        let referralCommission = 0;
        let referrerId = null;
        const [refCheck] = await connection.execute('SELECT referred_by FROM users WHERE id = ?', [userId]);
        if (refCheck.length && refCheck[0].referred_by && interestCovered > 0) {
            referrerId         = refCheck[0].referred_by;
            referralCommission = Math.round(interestCovered * 0.05);
        }

        const refId = 'PAY-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        // ─── Registrar en loan_payments ───
        await connection.execute(
            `INSERT INTO loan_payments (loan_id, user_id, amount, interest_amount, capital_amount, remaining_capital, loan_rate, ref_id, is_fully_paid, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [loanId, userId, amount, interestCovered, capitalReduced, newPendingCapital, loanRate, refId, isFullyPaid ? 1 : 0]
        );

        // ─── Comisión al referidor (sí entra a su balance) ───
        if (referrerId && referralCommission >= 100) {
            const referralRefId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
            try {
                await connection.execute(
                    `INSERT INTO referral_commissions (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id)
                     VALUES (?, ?, 'loan_interest', ?, ?, 0.05, ?, 'paid', ?)`,
                    [referrerId, userId, loanId, interestCovered, referralCommission, referralRefId]
                );
            } catch (e) { console.error('Error registrando comisión referido (admin abono):', e.message); }

            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'profit', ?, ?, ?, NOW())`,
                [referrerId, referralCommission, `Comisión referido — 5% intereses préstamo`, referralRefId]
            );
        }

        // ─── Actualizar préstamo ───
        const daysElapsed = Math.floor(secondsElapsed / 86400);
        const capitalizedNote = (amount < interestAccrued)
            ? ` | Capitalizado: $${Math.round(interestAccrued - amount).toLocaleString('es-CO')}`
            : '';
        const extraNote = notes ? ` (${String(notes).slice(0, 80)})` : '';
        const abonoNote = ` | ABONO EXTERNO $${Math.round(amount).toLocaleString('es-CO')} ${now.toISOString().slice(0, 10)} ref:${refId} (${daysElapsed}d, interes:$${Math.round(interestCovered).toLocaleString('es-CO')} capital:$${Math.round(capitalReduced).toLocaleString('es-CO')}${capitalizedNote})${extraNote}`;

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

        // El balance del cliente NO cambia (abono externo). Solo recalculamos
        // el del referidor si recibió comisión.
        if (referrerId && referralCommission >= 100) {
            await recalculateAndSaveBalance(connection, referrerId);
        }

        await connection.commit();

        const [userRows] = await pool.execute(`SELECT full_name FROM users WHERE id = ?`, [userId]);
        try {
            await notify(
                `💵 *ABONO EXTERNO A PRÉSTAMO (admin) — Sanse Capital*\n\n` +
                `👤 *${userRows[0]?.full_name || 'Usuario'}*\n` +
                `💰 Abono: *$${Math.round(amount).toLocaleString('es-CO')} COP*\n` +
                `📊 Intereses (${daysElapsed}d): $${Math.round(interestAccrued).toLocaleString('es-CO')}\n` +
                `   └ Cubiertos: $${Math.round(interestCovered).toLocaleString('es-CO')}\n` +
                `📉 Capital reducido: $${Math.round(capitalReduced).toLocaleString('es-CO')}\n` +
                `🏦 Capital pendiente: $${Math.round(newPendingCapital).toLocaleString('es-CO')} COP\n` +
                `${(amount < interestAccrued) ? `⚠️ Interés capitalizado: $${Math.round(interestAccrued - amount).toLocaleString('es-CO')}\n` : ''}` +
                `${isFullyPaid ? '✅ *PRÉSTAMO PAGADO COMPLETAMENTE*\n' : ''}` +
                `🔖 Ref abono: ${refId}`
            );
        } catch (e) {}

        res.json({
            message: isFullyPaid ? '¡Préstamo pagado completamente! 🎉' : 'Abono externo registrado exitosamente',
            payment: {
                amount,
                interestAccrued,
                interestCovered,
                interestCapitalized: Math.max(0, interestAccrued - amount),
                capitalReduced,
                daysElapsed,
                refId,
                remainingCapital: newPendingCapital,
                isFullyPaid,
            },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error abono externo admin:', error);
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