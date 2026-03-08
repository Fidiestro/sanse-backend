// ══════════════════════════════════════════════════════════════
// utils/balanceHelper.js — Sanse Capital
// FUENTE ÚNICA DE VERDAD para recálculo de balance de usuario.
// Todos los controllers deben importar esta función en lugar de
// tener su propia implementación.
// ══════════════════════════════════════════════════════════════

// Tipos de transacción que SUMAN al balance del usuario
const INFLOW_TYPES = [
    'deposit',
    'payment',
    'interest',
    'profit',
    'investment_return',
    'investment_withdrawal',
    'loan',
];

// Tipos de transacción que RESTAN del balance del usuario
const OUTFLOW_TYPES = [
    'withdraw',
];

// Todos los tipos válidos reconocidos por el sistema
const ALL_VALID_TYPES = [...INFLOW_TYPES, ...OUTFLOW_TYPES, 'investment'];

/**
 * Recalcula y guarda el balance de un usuario en balance_history.
 * 
 * @param {object} connection - Conexión MySQL (pool.getConnection() o pool)
 * @param {number} userId - ID del usuario
 * @returns {number} El nuevo balance calculado
 */
async function recalculateAndSaveBalance(connection, userId) {
    const inflowPlaceholders = INFLOW_TYPES.map(() => '?').join(',');
    const outflowPlaceholders = OUTFLOW_TYPES.map(() => '?').join(',');

    const [inRows] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total 
         FROM transactions 
         WHERE user_id = ? AND type IN (${inflowPlaceholders})`,
        [userId, ...INFLOW_TYPES]
    );
    const [outRows] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total 
         FROM transactions 
         WHERE user_id = ? AND type IN (${outflowPlaceholders})`,
        [userId, ...OUTFLOW_TYPES]
    );

    const newBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));
    const today = new Date().toISOString().slice(0, 10);

    const [existing] = await connection.execute(
        `SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ?`,
        [userId, today]
    );

    if (existing.length > 0) {
        await connection.execute(
            `UPDATE balance_history SET amount = ? WHERE user_id = ? AND snapshot_date = ?`,
            [newBalance, userId, today]
        );
    } else {
        await connection.execute(
            `INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`,
            [userId, newBalance, today]
        );
    }

    return newBalance;
}

/**
 * Valida que un tipo de transacción sea reconocido por el sistema.
 * 
 * @param {string} type - Tipo de transacción
 * @returns {boolean}
 */
function isValidTransactionType(type) {
    return ALL_VALID_TYPES.includes(type);
}

module.exports = {
    recalculateAndSaveBalance,
    isValidTransactionType,
    INFLOW_TYPES,
    OUTFLOW_TYPES,
    ALL_VALID_TYPES,
};
