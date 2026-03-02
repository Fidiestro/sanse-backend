// ══════════════════════════════════════════════════════════════
// REFERRAL & PROFILE CONTROLLER — Sanse Capital
// ══════════════════════════════════════════════════════════════
const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');
const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8468569082:AAEpx5VaQOtEQnrz9PHbkyh0O-_LTw0CaLg';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '1735923786';

function sendTelegramNotification(message) {
    const data = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' });
    const options = {
        hostname: 'api.telegram.org', path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    };
    const req = https.request(options);
    req.on('error', (e) => console.error('Telegram error:', e.message));
    req.write(data);
    req.end();
}

function generateReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'SC-';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// ══════════════════════════════════════════════════════════════
// POST /api/auth/register — Registro público de usuarios
// ══════════════════════════════════════════════════════════════
exports.publicRegister = async (req, res) => {
    try {
        const { fullName, email, password, phone, documentNumber, referralCode } = req.body;

        if (!fullName || !email || !password) {
            return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }

        // Verificar email único
        const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
        if (existing.length) return res.status(400).json({ error: 'Este correo ya está registrado' });

        // Verificar código de referido (opcional)
        let referredBy = null;
        if (referralCode && referralCode.trim()) {
            const [refUser] = await pool.execute('SELECT id FROM users WHERE referral_code = ?', [referralCode.trim().toUpperCase()]);
            if (!refUser.length) return res.status(400).json({ error: 'Código de referido inválido' });
            referredBy = refUser[0].id;
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const userReferralCode = generateReferralCode();

        const [result] = await pool.execute(
            `INSERT INTO users (full_name, email, password, phone, document_number, role, referral_code, referred_by, status, created_at) 
             VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 'active', NOW())`,
            [fullName.trim(), email.toLowerCase().trim(), hashedPassword, phone || null, documentNumber || null, userReferralCode, referredBy]
        );

        const userId = result.insertId;

        // Crear solicitud de registro para revisión admin
        await pool.execute(
            `INSERT INTO registration_requests (user_id, status) VALUES (?, 'pending')`,
            [userId]
        );

        // Notificar admin por Telegram
        sendTelegramNotification(
            `👤 *NUEVO REGISTRO — Sanse Capital*\n\n` +
            `📛 *${fullName}*\n` +
            `📧 ${email}\n` +
            `📱 ${phone || '—'}\n` +
            `🪪 CC: ${documentNumber || '—'}\n` +
            `🔗 Referido por: ${referralCode || 'Ninguno'}\n\n` +
            `➡️ Revisa en el panel admin para aprobar.`
        );

        res.status(201).json({
            message: 'Registro exitoso. Tu cuenta será revisada por el equipo de Sanse Capital.',
            userId,
            referralCode: userReferralCode,
        });
    } catch (error) {
        console.error('Error en registro público:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ══════════════════════════════════════════════════════════════
// GET /api/user/profile — Datos del perfil
// ══════════════════════════════════════════════════════════════
exports.getProfile = async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, full_name, email, phone, document_number, referral_code, referred_by, role, created_at FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
        
        const user = rows[0];

        // Nombre de quien lo refirió
        let referrerName = null;
        if (user.referred_by) {
            const [ref] = await pool.execute('SELECT full_name FROM users WHERE id = ?', [user.referred_by]);
            if (ref.length) referrerName = ref[0].full_name.split(' ')[0]; // solo primer nombre
        }

        res.json({
            ...user,
            referrerName,
        });
    } catch (error) {
        console.error('Error getProfile:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// PUT /api/user/profile — Actualizar datos personales
// ══════════════════════════════════════════════════════════════
exports.updateProfile = async (req, res) => {
    try {
        const { fullName, phone, documentNumber } = req.body;
        const updates = [];
        const params = [];

        if (fullName && fullName.trim()) { updates.push('full_name = ?'); params.push(fullName.trim()); }
        if (phone !== undefined) { updates.push('phone = ?'); params.push(phone || null); }
        if (documentNumber !== undefined) { updates.push('document_number = ?'); params.push(documentNumber || null); }

        if (!updates.length) return res.status(400).json({ error: 'No hay datos para actualizar' });

        params.push(req.user.id);
        await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

        res.json({ message: 'Perfil actualizado exitosamente' });
    } catch (error) {
        console.error('Error updateProfile:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// PUT /api/user/password — Cambiar contraseña
// ══════════════════════════════════════════════════════════════
exports.changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas' });
        if (newPassword.length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });

        const [rows] = await pool.execute('SELECT password FROM users WHERE id = ?', [req.user.id]);
        const isValid = await bcrypt.compare(currentPassword, rows[0].password);
        if (!isValid) return res.status(400).json({ error: 'Contraseña actual incorrecta' });

        const hashed = await bcrypt.hash(newPassword, 12);
        await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

        res.json({ message: 'Contraseña actualizada exitosamente' });
    } catch (error) {
        console.error('Error changePassword:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// GET /api/user/referrals — Mis referidos
// ══════════════════════════════════════════════════════════════
exports.getMyReferrals = async (req, res) => {
    try {
        const userId = req.user.id;

        // Mis referidos
        const [referrals] = await pool.execute(
            `SELECT id, full_name, created_at, 
                    (SELECT MAX(created_at) FROM transactions WHERE user_id = u.id) as last_activity
             FROM users u WHERE referred_by = ? ORDER BY created_at DESC`,
            [userId]
        );

        // Total comisiones ganadas
        const [commissions] = await pool.execute(
            `SELECT COALESCE(SUM(commission_amount), 0) as total, COUNT(*) as count 
             FROM referral_commissions WHERE referrer_id = ? AND status = 'paid'`,
            [userId]
        );

        // Mi código
        const [me] = await pool.execute('SELECT referral_code FROM users WHERE id = ?', [userId]);

        const now = new Date();
        const referralList = referrals.map(r => {
            const firstName = r.full_name.split(' ')[0];
            const createdAt = new Date(r.created_at);
            const monthsAgo = Math.max(0, Math.floor((now - createdAt) / (1000 * 60 * 60 * 24 * 30)));
            const lastAct = r.last_activity ? new Date(r.last_activity) : null;
            const daysInactive = lastAct ? Math.floor((now - lastAct) / (1000 * 60 * 60 * 24)) : 999;
            const isActive = daysInactive <= 30;

            return {
                firstName,
                months: monthsAgo,
                isActive,
                lastActivity: daysInactive <= 30 ? 'Activo' : daysInactive <= 90 ? `Hace ${daysInactive} días` : 'Inactivo',
            };
        });

        res.json({
            referralCode: me[0]?.referral_code || '',
            referralLink: `https://sansecapital.co/register.html?ref=${me[0]?.referral_code || ''}`,
            totalReferrals: referrals.length,
            totalCommissions: parseFloat(commissions[0].total),
            commissionCount: parseInt(commissions[0].count),
            referrals: referralList,
        });
    } catch (error) {
        console.error('Error getMyReferrals:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// COMISIÓN DE REFERIDO — Llamar desde investmentController y loanController
// processReferralCommission(referredUserId, sourceType, sourceId, amount)
// ══════════════════════════════════════════════════════════════
async function processReferralCommission(referredUserId, sourceType, sourceId, amount, connection = null) {
    const db = connection || pool;
    try {
        // Buscar si tiene referidor
        const [userRows] = await db.execute('SELECT referred_by FROM users WHERE id = ?', [referredUserId]);
        if (!userRows.length || !userRows[0].referred_by) return null;

        const referrerId = userRows[0].referred_by;
        const commissionRate = 0.05; // 5%
        const commissionAmount = Math.round(parseFloat(amount) * commissionRate);

        if (commissionAmount < 100) return null; // Mínimo $100 COP para crear comisión

        const refId = 'REF-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

        // Registrar comisión
        await db.execute(
            `INSERT INTO referral_commissions (referrer_id, referred_id, source_type, source_id, source_amount, commission_rate, commission_amount, status, ref_id) 
             VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?)`,
            [referrerId, referredUserId, sourceType, sourceId, amount, commissionRate, commissionAmount, refId]
        );

        // Crear transacción para el referidor
        await db.execute(
            `INSERT INTO transactions (user_id, type, amount, description, ref_id, created_at) VALUES (?, 'profit', ?, ?, ?, NOW())`,
            [referrerId, commissionAmount, `Comisión referido (5% de ${sourceType === 'investment_return' ? 'rendimiento SDTC' : 'intereses préstamo'})`, refId]
        );

        // Recalcular balance del referidor
        const [inRows] = await db.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('deposit','payment','interest','profit','investment_return','investment_withdrawal','loan')`,
            [referrerId]
        );
        const [outRows] = await db.execute(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type IN ('withdraw')`,
            [referrerId]
        );
        const newBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));
        const today = new Date().toISOString().slice(0, 10);
        const [existing] = await db.execute(`SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`, [referrerId, today]);
        if (existing.length) await db.execute(`UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`, [newBalance, referrerId, today]);
        else await db.execute(`INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`, [referrerId, newBalance, today]);

        return { referrerId, commissionAmount, refId };
    } catch (error) {
        console.error('Error procesando comisión de referido:', error);
        return null;
    }
}

// ══════════════════════════════════════════════════════════════
// ADMIN: GET /api/admin/registrations — Solicitudes de registro
// ══════════════════════════════════════════════════════════════
exports.adminGetRegistrations = async (req, res) => {
    try {
        const status = req.query.status || 'all';
        let query = `SELECT rr.*, u.full_name, u.email, u.phone, u.document_number, u.referral_code,
                            (SELECT ru.full_name FROM users ru WHERE ru.id = u.referred_by) as referrer_name
                     FROM registration_requests rr
                     JOIN users u ON rr.user_id = u.id`;
        const params = [];
        if (status !== 'all') { query += ` WHERE rr.status = ?`; params.push(status); }
        query += ` ORDER BY rr.created_at DESC`;

        const [rows] = await pool.execute(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Error adminGetRegistrations:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

// ══════════════════════════════════════════════════════════════
// ADMIN: POST /api/admin/registrations/:id/process
// ══════════════════════════════════════════════════════════════
exports.adminProcessRegistration = async (req, res) => {
    try {
        const { action, notes } = req.body;
        const regId = req.params.id;

        const [regRows] = await pool.execute(`SELECT * FROM registration_requests WHERE id = ?`, [regId]);
        if (!regRows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
        const reg = regRows[0];
        if (reg.status !== 'pending') return res.status(400).json({ error: 'Ya fue procesada' });

        if (action === 'approve') {
            await pool.execute(`UPDATE registration_requests SET status = 'approved', admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || null, req.user.id, regId]);
            // El usuario ya está activo desde el registro
        } else if (action === 'reject') {
            await pool.execute(`UPDATE registration_requests SET status = 'rejected', admin_notes = ?, processed_at = NOW(), processed_by = ? WHERE id = ?`,
                [notes || 'Rechazado', req.user.id, regId]);
            await pool.execute(`UPDATE users SET status = 'blocked' WHERE id = ?`, [reg.user_id]);
        }

        res.json({ message: action === 'approve' ? 'Registro aprobado' : 'Registro rechazado' });
    } catch (error) {
        console.error('Error adminProcessRegistration:', error);
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = exports;
module.exports.processReferralCommission = processReferralCommission;
