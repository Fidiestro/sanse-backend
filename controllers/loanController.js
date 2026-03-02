const { pool } = require('../config/database');

// ══════════════════════════════════════════════════════
// TELEGRAM NOTIFICATION (mismos datos que withdrawalController)
// ══════════════════════════════════════════════════════
const TELEGRAM_BOT_TOKEN = '8468569082:AAEpx5VaQOtEQnrz9PHbkyh0O-_LTw0CaLg';
const TELEGRAM_CHAT_ID = '1735923786';

async function sendTelegramNotification(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' }),
        });
    } catch (err) {
        console.error('Error enviando notificación Telegram:', err.message);
    }
}

// ══════════════════════════════════════════════════════════════
// SISTEMA DE PUNTOS CREDITICIOS — "Sanse Score"
// Máximo: 1000 puntos
// ══════════════════════════════════════════════════════════════
async function calculateCreditScore(userId) {
    const points = { total: 0, breakdown: {} };

    // 1. Antigüedad de la cuenta (máx 150 pts)
    const [acctRows] = await pool.execute(
        `SELECT created_at FROM users WHERE id = ?`, [userId]
    );
    if (acctRows.length) {
        const monthsActive = Math.max(0, Math.round((Date.now() - new Date(acctRows[0].created_at)) / (1000*60*60*24*30)));
        const acctPts = Math.min(150, monthsActive * 15); // 15 pts por mes, max 150
        points.breakdown.antiguedad = { pts: acctPts, max: 150, detail: `${monthsActive} meses activo` };
        points.total += acctPts;
    }

    // 2. Capital depositado total (máx 200 pts)
    const [depositRows] = await pool.execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('deposit', 'payment')`, [userId]
    );
    const totalDeposited = parseFloat(depositRows[0].total);
    const depositPts = Math.min(200, Math.floor(totalDeposited / 500000) * 20); // 20 pts por cada $500K, max 200
    points.breakdown.capital = { pts: depositPts, max: 200, detail: `$${Math.round(totalDeposited).toLocaleString('es-CO')} depositados` };
    points.total += depositPts;

    // 3. Inversiones SDTC activas/completadas (máx 200 pts)
    const [invRows] = await pool.execute(
        `SELECT COUNT(*) as active FROM investments WHERE user_id = ? AND status = 'active'`, [userId]
    );
    const [invCompRows] = await pool.execute(
        `SELECT COUNT(*) as completed FROM investments WHERE user_id = ? AND status = 'completed'`, [userId]
    );
    const activeInv = parseInt(invRows[0].active);
    const completedInv = parseInt(invCompRows[0].completed);
    const invPts = Math.min(200, (activeInv * 50) + (completedInv * 30));
    points.breakdown.inversiones = { pts: invPts, max: 200, detail: `${activeInv} activas, ${completedInv} completadas` };
    points.total += invPts;

    // 4. Historial de préstamos pagados (máx 250 pts)
    const [loanPaidRows] = await pool.execute(
        `SELECT COUNT(*) as paid FROM loan_requests WHERE user_id = ? AND status = 'paid'`, [userId]
    );
    const [loanLateRows] = await pool.execute(
        `SELECT COUNT(*) as late FROM loan_requests WHERE user_id = ? AND status = 'overdue'`, [userId]
    );
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

    // Cap at 1000
    points.total = Math.min(1000, points.total);

    // Tier
    if (points.total >= 800) points.tier = 'Platino';
    else if (points.total >= 600) points.tier = 'Oro';
    else if (points.total >= 400) points.tier = 'Plata';
    else if (points.total >= 200) points.tier = 'Bronce';
    else points.tier = 'Inicial';

    // Airdrop multiplier — más puntos = más tokens en el futuro airdrop
    points.airdropMultiplier = parseFloat((points.total / 1000 * 5).toFixed(2)); // max 5x

    return points;
}

// ══════════════════════════════════════════════════════════════
// GET /api/loans/my — Préstamos del usuario
// ══════════════════════════════════════════════════════════════
exports.getMyLoans = async (req, res) => {
    try {
        const userId = req.user.id;

        // Préstamos de la tabla loans (legacy)
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
        } catch(e) {} // tabla puede no existir

        // Solicitudes de préstamo (nueva tabla)
        let loanRequests = [];
        try {
            const [rows] = await pool.execute(
                `SELECT * FROM loan_requests WHERE user_id = ? ORDER BY created_at DESC`, [userId]
            );
            loanRequests = rows.map(l => ({
                id: l.id, source: 'request', amount: parseFloat(l.amount),
                monthlyRate: parseFloat(l.monthly_rate || 0), term: l.term_months,
                purpose: l.purpose, status: l.status, adminNotes: l.admin_notes,
                approvedAmount: l.approved_amount ? parseFloat(l.approved_amount) : null,
                approvedRate: l.approved_rate ? parseFloat(l.approved_rate) : null,
                startDate: l.start_date, dueDate: l.due_date,
                createdAt: l.created_at, processedAt: l.processed_at,
            }));
        } catch(e) {}

        res.json({ legacyLoans, loanRequests });
    } catch (error) {
        console.error('Error obteniendo préstamos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// GET /api/loans/credit-score — Puntos crediticios del usuario
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
// POST /api/loans/request — Solicitar un préstamo
// ══════════════════════════════════════════════════════════════
exports.requestLoan = async (req, res) => {
    try {
        const userId = req.user.id;
        const amount = parseFloat(req.body.amount);
        const { termMonths, purpose } = req.body;

        if (!amount || isNaN(amount) || !isFinite(amount) || amount < 100000) {
            return res.status(400).json({ error: 'Monto mínimo de préstamo: $100.000 COP' });
        }
        if (amount > 10000000) {
            return res.status(400).json({ error: 'Monto máximo de préstamo: $10.000.000 COP' });
        }
        if (!termMonths || ![1,2,3,6].includes(parseInt(termMonths))) {
            return res.status(400).json({ error: 'Plazo debe ser 1, 2, 3 o 6 meses' });
        }

        // Verificar no tener otro préstamo pendiente o activo
        try {
            const [existing] = await pool.execute(
                `SELECT COUNT(*) as c FROM loan_requests WHERE user_id = ? AND status IN ('pending', 'active')`, [userId]
            );
            if (existing[0].c > 0) {
                return res.status(400).json({ error: 'Ya tienes una solicitud pendiente o un préstamo activo. Espera a que se resuelva antes de solicitar otro.' });
            }
        } catch(e) {} // tabla puede no existir aún

        // Calcular credit score
        const score = await calculateCreditScore(userId);

        // Verificar score mínimo (200 para solicitar)
        if (score.total < 200) {
            return res.status(400).json({
                error: 'Tu Sanse Score es muy bajo para solicitar un préstamo. Necesitas mínimo 200 puntos. Invierte y ahorra para mejorar tu score.',
                currentScore: score.total,
                requiredScore: 200,
            });
        }

        const refId = 'LOAN-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();

        const [result] = await pool.execute(
            `INSERT INTO loan_requests (user_id, amount, term_months, purpose, credit_score, status, ref_id)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
            [userId, amount, parseInt(termMonths), purpose || null, score.total, refId]
        );

        // Notificación Telegram
        const [userRows] = await pool.execute(`SELECT full_name, email FROM users WHERE id = ?`, [userId]);
        const userName = userRows.length ? userRows[0].full_name : 'Usuario';
        const userEmail = userRows.length ? userRows[0].email : '';

        sendTelegramNotification(
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
// ADMIN: GET /api/admin/loans — Listar solicitudes de préstamo
// ══════════════════════════════════════════════════════════════
exports.adminGetLoans = async (req, res) => {
    try {
        const status = req.query.status || 'all';
        let query = `SELECT lr.*, u.full_name as user_name, u.email as user_email, u.document_number
                     FROM loan_requests lr
                     LEFT JOIN users u ON lr.user_id = u.id`;
        const params = [];
        if (status !== 'all') {
            query += ` WHERE lr.status = ?`;
            params.push(status);
        }
        query += ` ORDER BY lr.created_at DESC LIMIT 50`;

        const [rows] = await pool.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error obteniendo préstamos admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: POST /api/admin/loans/:id/process — Aprobar/rechazar préstamo
// ══════════════════════════════════════════════════════════════
exports.adminProcessLoan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const loanId = req.params.id;
        const { action, approvedAmount, approvedRate, notes } = req.body;
        // action: 'approve', 'reject', 'mark_paid', 'mark_overdue'

        if (!['approve', 'reject', 'mark_paid', 'mark_overdue'].includes(action)) {
            return res.status(400).json({ error: 'Acción inválida. Usar: approve, reject, mark_paid, mark_overdue' });
        }

        const [loanRows] = await connection.execute(`SELECT * FROM loan_requests WHERE id = ?`, [loanId]);
        if (!loanRows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
        const loan = loanRows[0];

        if (action === 'approve') {
            if (loan.status !== 'pending') return res.status(400).json({ error: 'Solo se pueden aprobar solicitudes pendientes' });

            const finalAmount = approvedAmount ? parseFloat(approvedAmount) : parseFloat(loan.amount);
            // Tasa: 4% si tiene inversiones SDTC (activas o pasadas), 6% si NO tiene
            let defaultRate = 6.0;
            const [investorCheck] = await connection.execute(
                `SELECT COUNT(*) as c FROM investments WHERE user_id = ?`, [loan.user_id]
            );
            if (parseInt(investorCheck[0].c) > 0) defaultRate = 4.0;
            const finalRate = approvedRate ? parseFloat(approvedRate) : defaultRate;

            const startDate = new Date();
            const dueDate = new Date();
            dueDate.setMonth(dueDate.getMonth() + parseInt(loan.term_months));

            await connection.execute(
                `UPDATE loan_requests SET status = 'active', approved_amount = ?, approved_rate = ?, monthly_rate = ?,
                 start_date = ?, due_date = ?, admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [finalAmount, finalRate, finalRate, startDate.toISOString().slice(0,10), dueDate.toISOString().slice(0,10), notes || null, req.user.id, loanId]
            );

            // Crear transacción de préstamo (suma al balance del usuario)
            const refId = 'LN-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'loan', ?, ?, ?, NOW())`,
                [loan.user_id, finalAmount, `Préstamo aprobado — ${loan.term_months} meses al ${finalRate}% mensual — Ref: ${loan.ref_id}`, refId]
            );

            // Recalcular balance
            const [inRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('deposit','payment','interest','profit','investment_return','investment_withdrawal','loan')`, [loan.user_id]
            );
            const [outRows] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('withdraw')`, [loan.user_id]
            );
            const newBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));
            const today = new Date().toISOString().slice(0,10);
            const [existing] = await connection.execute(`SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`, [loan.user_id, today]);
            if (existing.length) await connection.execute(`UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`, [newBalance, loan.user_id, today]);
            else await connection.execute(`INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`, [loan.user_id, newBalance, today]);

            // Telegram
            const [userRows] = await connection.execute(`SELECT full_name FROM users WHERE id = ?`, [loan.user_id]);
            sendTelegramNotification(
                `✅ *PRÉSTAMO APROBADO*\n\n👤 ${userRows[0]?.full_name || 'Usuario'}\n💰 $${Math.round(finalAmount).toLocaleString('es-CO')}\n📅 ${loan.term_months} meses al ${finalRate}%\n🔖 ${loan.ref_id}`
            );

        } else if (action === 'reject') {
            if (loan.status !== 'pending') return res.status(400).json({ error: 'Solo se pueden rechazar solicitudes pendientes' });
            await connection.execute(
                `UPDATE loan_requests SET status = 'rejected', admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || 'Rechazado por el administrador', req.user.id, loanId]
            );
        } else if (action === 'mark_paid') {
            if (loan.status !== 'active' && loan.status !== 'overdue') return res.status(400).json({ error: 'Solo préstamos activos o en mora' });
            await connection.execute(
                `UPDATE loan_requests SET status = 'paid', admin_notes = CONCAT(IFNULL(admin_notes,''), ' | PAGADO: ${new Date().toISOString().slice(0,10)}'), processed_at = NOW() WHERE id = ?`,
                [loanId]
            );
        } else if (action === 'mark_overdue') {
            if (loan.status !== 'active') return res.status(400).json({ error: 'Solo préstamos activos' });
            await connection.execute(
                `UPDATE loan_requests SET status = 'overdue', admin_notes = CONCAT(IFNULL(admin_notes,''), ' | MORA: ${notes || ''}') WHERE id = ?`,
                [loanId]
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
// POST /api/loans/pay — Abonar a un préstamo activo
// ══════════════════════════════════════════════════════════════
exports.payLoan = async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const userId = req.user.id;
        const { loanId, amount: rawAmount } = req.body;
        const amount = parseFloat(rawAmount);

        if (!loanId || !amount || isNaN(amount) || amount < 1000) {
            return res.status(400).json({ error: 'Monto mínimo de abono: $1.000 COP' });
        }

        // Verificar que el préstamo existe y pertenece al usuario
        const [loanRows] = await connection.execute(
            `SELECT * FROM loan_requests WHERE id = ? AND user_id = ? AND status IN ('active', 'overdue')`,
            [loanId, userId]
        );
        if (!loanRows.length) {
            return res.status(404).json({ error: 'Préstamo no encontrado o no está activo' });
        }
        const loan = loanRows[0];

        // Verificar balance disponible
        const [balanceRows] = await connection.execute(
            `SELECT amount FROM balance_history WHERE user_id = ? ORDER BY snapshot_date DESC LIMIT 1`, [userId]
        );
        const currentBalance = balanceRows.length ? parseFloat(balanceRows[0].amount) : 0;

        const [investedRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM investments WHERE user_id = ? AND status IN ('active', 'pending_deposit')`, [userId]
        );
        const totalInvested = parseFloat(investedRows[0].total);

        const [pendingWR] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawal_requests WHERE user_id = ? AND status IN ('pending', 'approved')`, [userId]
        );
        const pendingWithdrawals = parseFloat(pendingWR[0].total);
        const availableBalance = currentBalance - totalInvested - pendingWithdrawals;

        if (amount > availableBalance) {
            return res.status(400).json({
                error: `Saldo disponible insuficiente. Disponible: $${Math.round(Math.max(0, availableBalance)).toLocaleString('es-CO')} COP`,
                available: Math.max(0, availableBalance),
            });
        }

        // Crear transacción de abono (tipo payment, resta del balance)
        const refId = 'PAY-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
        const loanRate = parseFloat(loan.approved_rate || loan.monthly_rate || 4);
        const capital = parseFloat(loan.approved_amount || loan.amount);

        // Calcular cuánto del abono corresponde a intereses del mes
        const monthlyInterest = Math.round(capital * (loanRate / 100));
        // El interés incluido en este abono es el mínimo entre el monto abonado y el interés mensual
        const interestPortion = Math.min(amount, monthlyInterest);

        // Comisión de referido: 5% de la porción de intereses
        let referralCommission = 0;
        let referrerId = null;
        const [refCheck] = await connection.execute('SELECT referred_by FROM users WHERE id = ?', [userId]);
        if (refCheck.length && refCheck[0].referred_by && interestPortion > 0) {
            referrerId = refCheck[0].referred_by;
            referralCommission = Math.round(interestPortion * 0.05);
        }

        // El abono efectivo que se registra como retiro del usuario es el monto completo
        // (el usuario paga el total, pero de ese pago los intereses van: 95% a Sanse, 5% al referidor)
        await connection.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'withdraw', ?, ?, ?, NOW())`,
            [userId, amount, `Abono préstamo — Ref: ${loan.ref_id} — Capital: $${Math.round(capital).toLocaleString('es-CO')}`, refId]
        );

        // Si hay comisión de referido, crear transacción de ganancia para el referidor
        let referralRefId = null;
        if (referrerId && referralCommission >= 100) {
            referralRefId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

            try {
                await connection.execute(
                    `INSERT INTO referral_commissions (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id) 
                     VALUES (?, ?, 'loan_interest', ?, ?, 0.05, ?, 'paid', ?)`,
                    [referrerId, userId, loanId, interestPortion, referralCommission, referralRefId]
                );
            } catch(e) { console.error('Error registrando comisión referido préstamo:', e.message); }

            await connection.execute(
                `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'profit', ?, ?, ?, NOW())`,
                [referrerId, referralCommission, `Comisión referido — 5% de intereses préstamo`, referralRefId]
            );
        }

        // Registrar abono en notas del préstamo
        await connection.execute(
            `UPDATE loan_requests SET admin_notes = CONCAT(IFNULL(admin_notes,''), ' | ABONO $${Math.round(amount).toLocaleString('es-CO')} ${new Date().toISOString().slice(0,10)} ref:${refId}') WHERE id = ?`,
            [loanId]
        );

        // Recalcular balance
        const [inRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('deposit','payment','interest','profit','investment_return','investment_withdrawal','loan')`, [userId]
        );
        const [outRows] = await connection.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('withdraw')`, [userId]
        );
        const newBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));
        const today = new Date().toISOString().slice(0,10);
        const [existing] = await connection.execute(`SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`, [userId, today]);
        if (existing.length) await connection.execute(`UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`, [newBalance, userId, today]);
        else await connection.execute(`INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`, [userId, newBalance, today]);

        // Recalcular balance del referidor si hubo comisión
        if (referrerId && referralCommission >= 100) {
            const [refIn] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('deposit','payment','interest','profit','investment_return','investment_withdrawal','loan')`, [referrerId]
            );
            const [refOut] = await connection.execute(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('withdraw')`, [referrerId]
            );
            const refBalance = Math.max(0, parseFloat(refIn[0].total) - parseFloat(refOut[0].total));
            const [refExisting] = await connection.execute(`SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`, [referrerId, today]);
            if (refExisting.length) await connection.execute(`UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`, [refBalance, referrerId, today]);
            else await connection.execute(`INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`, [referrerId, refBalance, today]);
        }

        await connection.commit();

        // Notificación Telegram
        const [userRows] = await pool.execute(`SELECT full_name, email FROM users WHERE id = ?`, [userId]);
        const userName = userRows.length ? userRows[0].full_name : 'Usuario';

        sendTelegramNotification(
            `💳 *ABONO A PRÉSTAMO — Sanse Capital*\n\n` +
            `👤 *${userName}*\n` +
            `💰 Abono: *$${Math.round(amount).toLocaleString('es-CO')} COP*\n` +
            `🏦 Préstamo: ${loan.ref_id} — Capital: $${Math.round(capital).toLocaleString('es-CO')}\n` +
            `🔖 Ref abono: ${refId}`
        );

        res.json({
            message: 'Abono registrado exitosamente',
            payment: { amount, refId, newBalance },
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error abonando préstamo:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
};
