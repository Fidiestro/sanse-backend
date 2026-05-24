// ══════════════════════════════════════════════════════════════
// utils/balanceHelper.js — Sanse Capital
// v3 — FIXES:
//  - BUG #5: manejo defensivo de duplicados en balance_history
//  - Agrega 'fee' como OUTFLOW (Pool 2% entrada como tx separada)
//
// FUENTE ÚNICA DE VERDAD para recálculo de balance de usuario.
// ══════════════════════════════════════════════════════════════

const INFLOW_TYPES = [
    'deposit',
    'payment',
    'interest',
    'profit',
    'investment_return',
    'investment_withdrawal',
    'loan',
];

const OUTFLOW_TYPES = [
    'withdraw',
    'fee',  // FIX: comisiones (ej: 2% entrada Pool) registradas como tx separada
];

// 'investment' es especial: se guarda con amount NEGATIVO en la columna
const ALL_VALID_TYPES = [...INFLOW_TYPES, ...OUTFLOW_TYPES, 'investment'];

async function recalculateAndSaveBalance(connection, userId) {
    const inflowPH = INFLOW_TYPES.map(() => '?').join(',');
    const outflowPH = OUTFLOW_TYPES.map(() => '?').join(',');

    const [inRows] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE user_id = ? AND type IN (${inflowPH})`,
        [userId, ...INFLOW_TYPES]
    );
    const [outRows] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE user_id = ? AND type IN (${outflowPH})`,
        [userId, ...OUTFLOW_TYPES]
    );

    const newBalance = Math.max(0, parseFloat(inRows[0].total) - parseFloat(outRows[0].total));
    const today = new Date().toISOString().slice(0, 10);

    // FIX BUG #5: manejo defensivo de duplicados en balance_history
    const [existing] = await connection.execute(
        `SELECT id FROM balance_history WHERE user_id = ? AND snapshot_date = ? ORDER BY id ASC`,
        [userId, today]
    );

    if (existing.length === 0) {
        await connection.execute(
            `INSERT INTO balance_history (user_id, amount, snapshot_date) VALUES (?, ?, ?)`,
            [userId, newBalance, today]
        );
    } else if (existing.length === 1) {
        await connection.execute(
            `UPDATE balance_history SET amount = ? WHERE id = ?`,
            [newBalance, existing[0].id]
        );
    } else {
        // Defensivo: consolidar duplicados si existieran
        console.warn(`[balanceHelper] ${existing.length} duplicados en balance_history user_id=${userId} fecha=${today}. Consolidando.`);
        const keepId = existing[0].id;
        const deleteIds = existing.slice(1).map(r => r.id);
        if (deleteIds.length > 0) {
            const ph = deleteIds.map(() => '?').join(',');
            await connection.execute(`DELETE FROM balance_history WHERE id IN (${ph})`, deleteIds);
        }
        await connection.execute(
            `UPDATE balance_history SET amount = ? WHERE id = ?`,
            [newBalance, keepId]
        );
    }

    return newBalance;
}

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