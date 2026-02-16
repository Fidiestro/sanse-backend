const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

class User {
    static async create({ email, password, fullName, phone, documentType, documentNumber, role = 'client' }) {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const [result] = await pool.execute(
            `INSERT INTO users (email, password_hash, full_name, phone, document_type, document_number, role)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [email.toLowerCase().trim(), passwordHash, fullName, phone || null, documentType || 'CC', documentNumber || null, role]
        );
        return result.insertId;
    }

    static async findByEmail(email) {
        const [rows] = await pool.execute(
            'SELECT * FROM users WHERE email = ? AND is_active = 1',
            [email.toLowerCase().trim()]
        );
        return rows[0] || null;
    }

    static async findById(id) {
        const [rows] = await pool.execute(
            `SELECT id, email, full_name, phone, document_type, document_number, 
                    role, is_active, email_verified, avatar_url, monthly_goal, 
                    created_at, updated_at 
             FROM users WHERE id = ? AND is_active = 1`,
            [id]
        );
        return rows[0] || null;
    }

    static async verifyPassword(plainPassword, hashedPassword) {
        return bcrypt.compare(plainPassword, hashedPassword);
    }

    static async update(id, fields) {
        const allowed = ['full_name', 'phone', 'document_type', 'document_number', 'avatar_url', 'monthly_goal'];
        const updates = [];
        const values = [];
        for (const [key, value] of Object.entries(fields)) {
            if (allowed.includes(key)) {
                updates.push(`${key} = ?`);
                values.push(value);
            }
        }
        if (updates.length === 0) return false;
        values.push(id);
        await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
        return true;
    }

    static async updatePassword(id, newPassword) {
        const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
        return true;
    }

    static async findAll({ page = 1, limit = 20, role } = {}) {
        const offset = (page - 1) * limit;
        let query = `SELECT id, email, full_name, phone, role, is_active, created_at FROM users WHERE is_active = 1`;
        const params = [];
        if (role) { query += ' AND role = ?'; params.push(role); }
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        const [rows] = await pool.execute(query, params);
        let countQuery = 'SELECT COUNT(*) as total FROM users WHERE is_active = 1';
        const countParams = [];
        if (role) { countQuery += ' AND role = ?'; countParams.push(role); }
        const [countRows] = await pool.execute(countQuery, countParams);
        return { users: rows, total: countRows[0].total, page, totalPages: Math.ceil(countRows[0].total / limit) };
    }

    static async deactivate(id) {
        await pool.execute('UPDATE users SET is_active = 0 WHERE id = ?', [id]);
        return true;
    }

    static async countAdmins() {
        const [rows] = await pool.execute("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1");
        return rows[0].count;
    }
}

module.exports = User;
