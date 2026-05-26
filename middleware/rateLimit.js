const rateLimit = require('express-rate-limit');
const { pool } = require('../config/database');

// ══════════════════════════════════════════════════════════════
// generalLimiter — Limita requests a la API en general.
// FIX: Subido a 600 req/15min (40/min) y ventana reducida a 5min.
// Una SPA activa hace 10-30 requests por sesión, esto deja margen
// generoso sin abrir la puerta a abuso.
// ══════════════════════════════════════════════════════════════
const generalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,   // 5 minutos
    max: 600,                   // 600 requests / 5min (≈ 2 req/seg sostenido)
    message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
    // No limitar preflight CORS
    skip: (req) => req.method === 'OPTIONS',
    // Por usuario autenticado si hay token, sino por IP
    keyGenerator: (req) => {
        const auth = req.headers.authorization;
        if (auth && auth.startsWith('Bearer ')) {
            // Hash simple del token para no exponer en memoria el JWT completo
            return 'u_' + auth.slice(7, 27);
        }
        return req.ip;
    },
});

// loginLimiter sigue estricto: 5 intentos / 15min POR (ip + email).
// Protege contra brute force sin afectar uso normal.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
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
