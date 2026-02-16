const rateLimit = require('express-rate-limit');
const { pool } = require('../config/database');

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Demasiadas solicitudes. Intenta de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}_${req.body?.email || 'unknown'}`,
});

async function logLoginAttempt(email, ip, success) {
    try {
        await pool.execute(
            'INSERT INTO login_attempts (email, ip_address, success) VALUES (?, ?, ?)',
            [email, ip, success ? 1 : 0]
        );
    } catch (error) {
        console.error('Error registrando intento de login:', error.message);
    }
}

async function isBlocked(email, ip) {
    try {
        const [rows] = await pool.execute(
            `SELECT COUNT(*) as attempts FROM login_attempts 
             WHERE (email = ? OR ip_address = ?) AND success = 0 
             AND attempted_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE)`,
            [email, ip]
        );
        return rows[0].attempts >= 10;
    } catch (error) {
        return false;
    }
}

module.exports = { generalLimiter, loginLimiter, logLoginAttempt, isBlocked };
