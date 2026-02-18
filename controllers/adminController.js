const { pool } = require('../config/database');

// POST /api/admin/investments — Crear inversión para un usuario
exports.createInvestment = async (req, res) => {
    try {
        const { userId, type, amount, annualRate, startDate, status } = req.body;
        if (!userId || !type || !amount || !annualRate) {
            return res.status(400).json({ error: 'userId, type, amount y annualRate son requeridos' });
        }
        const [result] = await pool.execute(
            `INSERT INTO investments (user_id, type, amount, annual_rate, start_date, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, type, amount, annualRate, startDate || new Date().toISOString().split('T')[0], status || 'active']
        );
        res.status(201).json({ message: 'Inversión creada', id: result.insertId });
    } catch (error) {
        console.error('Error creando inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/transactions — Crear transacción
exports.createTransaction = async (req, res) => {
    try {
        const { userId, type, amount, description, date } = req.body;
        if (!userId || !type || !amount) {
            return res.status(400).json({ error: 'userId, type y amount son requeridos' });
        }
        const validTypes = ['deposit', 'profit', 'withdraw'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: 'type debe ser: deposit, profit o withdraw' });
        }
        const createdAt = date || new Date().toISOString();
        const [result] = await pool.execute(
            `INSERT INTO transactions (user_id, type, amount, description, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [userId, type, amount, description || '', createdAt]
        );
        res.status(201).json({ message: 'Transacción creada', id: result.insertId });
    } catch (error) {
        console.error('Error creando transacción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// POST /api/admin/balance — Registrar balance
exports.recordBalance = async (req, res) => {
    try {
        const { userId, balance, date } = req.body;
        if (!userId || balance === undefined) {
            return res.status(400).json({ error: 'userId y balance son requeridos' });
        }
        const recordedAt = date || new Date().toISOString();
        const [result] = await pool.execute(
            `INSERT INTO balance_history (user_id, balance, recorded_at)
             VALUES (?, ?, ?)`,
            [userId, balance, recordedAt]
        );
        res.status(201).json({ message: 'Balance registrado', id: result.insertId });
    } catch (error) {
        console.error('Error registrando balance:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// GET /api/admin/users/:id/details — Detalles completos de un usuario
exports.getUserDetails = async (req, res) => {
    try {
        const userId = req.params.id;

        const [user] = await pool.execute(
            `SELECT id, email, full_name, phone, role, monthly_goal, created_at 
             FROM users WHERE id = ? AND is_active = 1`, [userId]
        );
        if (!user.length) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [investments] = await pool.execute(
            `SELECT * FROM investments WHERE user_id = ? ORDER BY start_date DESC`, [userId]
        );
        const [transactions] = await pool.execute(
            `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [userId]
        );
        const [balanceHistory] = await pool.execute(
            `SELECT * FROM balance_history WHERE user_id = ? ORDER BY recorded_at ASC`, [userId]
        );

        res.json({
            user: user[0],
            investments,
            transactions,
            balanceHistory,
        });
    } catch (error) {
        console.error('Error obteniendo detalles:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// DELETE /api/admin/investments/:id
exports.deleteInvestment = async (req, res) => {
    try {
        await pool.execute('DELETE FROM investments WHERE id = ?', [req.params.id]);
        res.json({ message: 'Inversión eliminada' });
    } catch (error) {
        console.error('Error eliminando inversión:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// DELETE /api/admin/transactions/:id
exports.deleteTransaction = async (req, res) => {
    try {
        await pool.execute('DELETE FROM transactions WHERE id = ?', [req.params.id]);
        res.json({ message: 'Transacción eliminada' });
    } catch (error) {
        console.error('Error eliminando transacción:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};
