const User = require('../models/User');
const { generateTokens } = require('../middleware/auth');
const { logLoginAttempt, isBlocked } = require('../middleware/rateLimit');
const { isValidEmail, isStrongPassword, sanitize, auditLog } = require('../utils/helpers');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña son requeridos' });
        }
        const ip = req.ip || req.connection.remoteAddress;
        const blocked = await isBlocked(email, ip);
        if (blocked) {
            return res.status(429).json({ error: 'Cuenta temporalmente bloqueada por múltiples intentos fallidos. Intenta en 30 minutos.' });
        }
        const user = await User.findByEmail(email);
        if (!user) {
            await logLoginAttempt(email, ip, false);
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }
        const validPassword = await User.verifyPassword(password, user.password_hash);
        if (!validPassword) {
            await logLoginAttempt(email, ip, false);
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }
        await logLoginAttempt(email, ip, true);
        const tokens = generateTokens(user.id);
        await auditLog({ userId: user.id, action: 'login', entityType: 'user', entityId: user.id, details: { method: 'email_password' }, ipAddress: ip });
        res.json({
            message: 'Login exitoso',
            user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, avatarUrl: user.avatar_url },
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ error: 'Refresh token requerido' });
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Token inválido' });
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
        const tokens = generateTokens(user.id);
        res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    } catch (error) {
        if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Refresh token expirado. Inicia sesión nuevamente.' });
        res.status(401).json({ error: 'Token inválido' });
    }
};

exports.getProfile = async (req, res) => {
    try {
        const user = req.user;
        res.json({
            id: user.id, email: user.email, fullName: user.full_name, phone: user.phone,
            documentType: user.document_type, documentNumber: user.document_number,
            role: user.role, monthlyGoal: user.monthly_goal, avatarUrl: user.avatar_url, createdAt: user.created_at,
        });
    } catch (error) {
        console.error('Error obteniendo perfil:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const allowed = ['full_name', 'phone', 'document_type', 'document_number', 'monthly_goal'];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = sanitize(req.body[key]);
        }
        await User.update(req.user.id, updates);
        await auditLog({ userId: req.user.id, action: 'update_profile', entityType: 'user', entityId: req.user.id, details: { fields: Object.keys(updates) }, ipAddress: req.ip });
        const updatedUser = await User.findById(req.user.id);
        res.json({ message: 'Perfil actualizado', user: updatedUser });
    } catch (error) {
        console.error('Error actualizando perfil:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas' });
        if (!isStrongPassword(newPassword)) return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 8 caracteres, 1 mayúscula, 1 minúscula y 1 número' });
        const user = await User.findByEmail(req.user.email);
        const valid = await User.verifyPassword(currentPassword, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
        await User.updatePassword(req.user.id, newPassword);
        await auditLog({ userId: req.user.id, action: 'change_password', entityType: 'user', entityId: req.user.id, ipAddress: req.ip });
        res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error) {
        console.error('Error cambiando contraseña:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.createUser = async (req, res) => {
    try {
        const { email, password, fullName, phone, documentType, documentNumber, role } = req.body;
        if (!email || !password || !fullName) return res.status(400).json({ error: 'Email, contraseña y nombre son requeridos' });
        if (!isValidEmail(email)) return res.status(400).json({ error: 'Email inválido' });
        if (!isStrongPassword(password)) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres, 1 mayúscula, 1 minúscula y 1 número' });
        const existing = await User.findByEmail(email);
        if (existing) return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
        const userId = await User.create({ email, password, fullName: sanitize(fullName), phone, documentType, documentNumber, role: role || 'client' });
        await auditLog({ userId: req.user.id, action: 'create_user', entityType: 'user', entityId: userId, details: { email, role: role || 'client' }, ipAddress: req.ip });
        res.status(201).json({ message: 'Usuario creado exitosamente', userId });
    } catch (error) {
        console.error('Error creando usuario:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.listUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const role = req.query.role;
        const result = await User.findAll({ page, limit, role });
        res.json(result);
    } catch (error) {
        console.error('Error listando usuarios:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

exports.setup = async (req, res) => {
    try {
        const adminCount = await User.countAdmins();
        if (adminCount > 0) return res.status(403).json({ error: 'Setup ya fue completado. Ya existe un administrador.' });
        const email = process.env.ADMIN_EMAIL;
        const password = process.env.ADMIN_PASSWORD;
        const name = process.env.ADMIN_NAME || 'Admin Sanse';
        if (!email || !password) return res.status(400).json({ error: 'Variables ADMIN_EMAIL y ADMIN_PASSWORD no configuradas' });
        const userId = await User.create({ email, password, fullName: name, role: 'admin' });
        await auditLog({ userId, action: 'initial_setup', entityType: 'user', entityId: userId, details: { email }, ipAddress: req.ip });
        res.status(201).json({ message: '✅ Admin creado exitosamente. Ya puedes iniciar sesión.', email });
    } catch (error) {
        console.error('Error en setup:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};
