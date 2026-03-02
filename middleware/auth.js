const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// ══════════════════════════════════════════════════════════════
// Generar tokens JWT (access + refresh)
// ══════════════════════════════════════════════════════════════
function generateTokens(userId) {
    const accessToken = jwt.sign(
        { id: userId, type: 'access' },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );
    const refreshToken = jwt.sign(
        { userId, type: 'refresh' },
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );
    return { accessToken, refreshToken };
}

// ══════════════════════════════════════════════════════════════
// Middleware: Autenticar usuario via JWT
// ══════════════════════════════════════════════════════════════
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token de acceso requerido' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
        if (!users.length) {
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }

        const user = users[0];

        // Verificar si el usuario está bloqueado
        if (user.status === 'blocked') {
            return res.status(403).json({ 
                error: 'Tu cuenta ha sido suspendida. Contacta al administrador para más información.',
                blocked: true 
            });
        }

        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expirado', expired: true });
        }
        return res.status(401).json({ error: 'Token inválido' });
    }
};

// ══════════════════════════════════════════════════════════════
// Middleware: Verificar rol admin (incluye p2p)
// ══════════════════════════════════════════════════════════════
const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.role !== 'p2p') {
        return res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
    }
    next();
};

module.exports = { authenticate, requireAdmin, generateTokens };