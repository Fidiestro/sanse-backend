const validator = require('validator');
const { pool } = require('../config/database');

function isValidEmail(email) {
    return validator.isEmail(email || '');
}

function isStrongPassword(password) {
    return validator.isStrongPassword(password, {
        minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 0,
    });
}

function sanitize(str) {
    if (typeof str !== 'string') return str;
    return validator.escape(validator.trim(str));
}

async function auditLog({ userId, action, entityType, entityId, details, ipAddress }) {
    try {
        await pool.execute(
            `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId || null, action, entityType || null, entityId || null, JSON.stringify(details || {}), ipAddress || null]
        );
    } catch (error) {
        console.error('Error en audit log:', error.message);
    }
}

module.exports = { isValidEmail, isStrongPassword, sanitize, auditLog };
