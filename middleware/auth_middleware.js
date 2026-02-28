// ═══════════════════════════════════════════════════════════════
// PARCHE: Agregar verificación de usuario bloqueado al middleware auth
// ═══════════════════════════════════════════════════════════════
// 
// En tu archivo middleware/auth.js, dentro de la función `authenticate`,
// DESPUÉS de verificar el JWT y ANTES de llamar a next(), agrega:
//
// === CÓDIGO A AGREGAR ===

// Dentro de authenticate, después de: const decoded = jwt.verify(token, process.env.JWT_SECRET);
// y después de: const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);

// Agregar ANTES de req.user = user y next():

/*
    // Verificar si el usuario está bloqueado
    if (user.status === 'blocked') {
        return res.status(403).json({ 
            error: 'Tu cuenta ha sido suspendida. Contacta al administrador.',
            blocked: true 
        });
    }
*/

// ═══════════════════════════════════════════════════════════════
// Si tu middleware/auth.js se ve algo así, este es el cambio exacto:
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

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

        // ✅ NUEVO: Verificar si el usuario está bloqueado
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

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
    }
    next();
};

module.exports = { authenticate, requireAdmin };
