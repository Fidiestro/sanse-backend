// ══════════════════════════════════════════════════════════════════════
// controllers/companyInvestmentController.js — Sanse Capital
//
// Módulo de INVERSIONES DE EMPRESA (tesorería interna).
// Registro contable del capital que la empresa toma de las LP COP para
// invertir por fuera (dólares, Retroensambles, etc.) + rendimientos/ventas
// registrados manualmente.
//
// ⚠️ CERO IMPACTO en clientes:
//   - NO toca investments, transactions, balance_history ni LP COP
//   - NO afecta el balance de ningún usuario
//   - Solo lee/escribe company_investments y company_investment_returns
//
// REQUIERE: haber corrido 003_company_investments.sql
// ══════════════════════════════════════════════════════════════════════

const { pool } = require('../config/database');

// Cuentas internas sugeridas (el admin puede escribir otras libremente)
const SUGGESTED_ACCOUNTS = ['Sanse Capital', 'Inversion Activos', 'Retroensambles Fusa'];

// ───────────────────────────────────────────────────────────────────────
// GET /api/admin/company-investments
// Lista todas las inversiones de empresa con su capital y ganancias.
// Query opcional: ?status=active|closed
// ───────────────────────────────────────────────────────────────────────
exports.list = async (req, res) => {
    try {
        const { status } = req.query;

        let query = `
            SELECT
                ci.id, ci.account_label, ci.name, ci.capital_deployed,
                ci.source_note, ci.status, ci.start_date, ci.closed_at, ci.created_at,
                COALESCE(SUM(cir.amount), 0) AS total_returns,
                COUNT(cir.id) AS returns_count
            FROM company_investments ci
            LEFT JOIN company_investment_returns cir ON cir.company_investment_id = ci.id
        `;
        const params = [];
        if (status === 'active' || status === 'closed') {
            query += ' WHERE ci.status = ?';
            params.push(status);
        }
        query += ' GROUP BY ci.id ORDER BY ci.created_at DESC';

        const [rows] = await pool.query(query, params);

        // Totales globales para las tarjetas de stats
        const totalCapital = rows.reduce((s, r) => s + parseFloat(r.capital_deployed || 0), 0);
        const totalReturns = rows.reduce((s, r) => s + parseFloat(r.total_returns || 0), 0);
        const activeCount = rows.filter(r => r.status === 'active').length;

        res.json({
            investments: rows.map(r => ({
                id: r.id,
                accountLabel: r.account_label,
                name: r.name,
                capitalDeployed: parseFloat(r.capital_deployed || 0),
                totalReturns: parseFloat(r.total_returns || 0),
                returnsCount: parseInt(r.returns_count || 0),
                sourceNote: r.source_note,
                status: r.status,
                startDate: r.start_date,
                closedAt: r.closed_at,
                createdAt: r.created_at,
            })),
            stats: {
                totalCapitalDeployed: totalCapital,
                totalReturns: totalReturns,
                activeCount,
                netResult: totalReturns, // ganancia acumulada de la empresa
            },
            suggestedAccounts: SUGGESTED_ACCOUNTS,
        });
    } catch (e) {
        console.error('[companyInvestment.list]', e);
        if (e.code === 'ER_NO_SUCH_TABLE') {
            return res.status(503).json({ error: 'Falta correr la migración 003_company_investments.sql' });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// GET /api/admin/company-investments/:id/returns
// Detalle de rendimientos/ventas de una inversión de empresa.
// ───────────────────────────────────────────────────────────────────────
exports.getReturns = async (req, res) => {
    try {
        const { id } = req.params;

        const [invRows] = await pool.execute(
            `SELECT * FROM company_investments WHERE id = ?`, [id]
        );
        if (!invRows.length) return res.status(404).json({ error: 'Inversión no encontrada' });

        const [returns] = await pool.execute(
            `SELECT id, amount, kind, note, event_date, created_at
             FROM company_investment_returns
             WHERE company_investment_id = ?
             ORDER BY COALESCE(event_date, created_at) DESC, id DESC`,
            [id]
        );

        const inv = invRows[0];
        const totalReturns = returns.reduce((s, r) => s + parseFloat(r.amount), 0);

        res.json({
            investment: {
                id: inv.id,
                accountLabel: inv.account_label,
                name: inv.name,
                capitalDeployed: parseFloat(inv.capital_deployed),
                status: inv.status,
                sourceNote: inv.source_note,
                startDate: inv.start_date,
            },
            totalReturns,
            netResult: totalReturns,
            returns: returns.map(r => ({
                id: r.id,
                amount: parseFloat(r.amount),
                kind: r.kind,
                note: r.note,
                eventDate: r.event_date,
                createdAt: r.created_at,
            })),
        });
    } catch (e) {
        console.error('[companyInvestment.getReturns]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// POST /api/admin/company-investments
// Crea una inversión de empresa (registra capital tomado).
// Body: { accountLabel, name, capitalDeployed, sourceNote?, startDate? }
// ───────────────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
    try {
        const { accountLabel, name, sourceNote } = req.body;
        const capital = parseFloat(req.body.capitalDeployed);
        const rawStart = (req.body.startDate || '').toString().trim();

        if (!accountLabel || !String(accountLabel).trim()) {
            return res.status(400).json({ error: 'La cuenta interna (accountLabel) es requerida' });
        }
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'El nombre de la inversión es requerido' });
        }
        if (!capital || isNaN(capital) || capital <= 0) {
            return res.status(400).json({ error: 'El capital debe ser mayor a 0' });
        }

        let startDate = null;
        if (rawStart) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
                return res.status(400).json({ error: 'Fecha de inicio inválida (YYYY-MM-DD)' });
            }
            startDate = rawStart;
        }

        const [result] = await pool.execute(
            `INSERT INTO company_investments
                (account_label, name, capital_deployed, source_note, status, created_by, start_date, created_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, NOW())`,
            [
                String(accountLabel).trim().slice(0, 120),
                String(name).trim().slice(0, 200),
                capital,
                sourceNote ? String(sourceNote).trim() : null,
                req.user.id,
                startDate,
            ]
        );

        res.status(201).json({
            message: 'Inversión de empresa registrada',
            id: result.insertId,
        });
    } catch (e) {
        console.error('[companyInvestment.create]', e);
        if (e.code === 'ER_NO_SUCH_TABLE') {
            return res.status(503).json({ error: 'Falta correr la migración 003_company_investments.sql' });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// POST /api/admin/company-investments/:id/returns
// Registra manualmente un rendimiento / venta / pérdida.
// Body: { amount, kind?: 'return'|'sale'|'loss', note?, eventDate? }
// ───────────────────────────────────────────────────────────────────────
exports.addReturn = async (req, res) => {
    try {
        const { id } = req.params;
        const { note } = req.body;
        let { kind } = req.body;
        let amount = parseFloat(req.body.amount);
        const rawDate = (req.body.eventDate || '').toString().trim();

        if (isNaN(amount) || amount === 0) {
            return res.status(400).json({ error: 'El monto es requerido y distinto de 0' });
        }
        if (!['return', 'sale', 'loss'].includes(kind)) kind = 'return';
        // Para pérdidas, forzar monto negativo
        if (kind === 'loss') amount = -Math.abs(amount);

        // Verificar que la inversión exista
        const [invRows] = await pool.execute(
            `SELECT id, status FROM company_investments WHERE id = ?`, [id]
        );
        if (!invRows.length) return res.status(404).json({ error: 'Inversión no encontrada' });

        let eventDate = null;
        if (rawDate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
                return res.status(400).json({ error: 'Fecha inválida (YYYY-MM-DD)' });
            }
            eventDate = rawDate;
        }

        const [result] = await pool.execute(
            `INSERT INTO company_investment_returns
                (company_investment_id, amount, kind, note, registered_by, event_date, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [id, amount, kind, note ? String(note).trim() : null, req.user.id, eventDate]
        );

        res.status(201).json({
            message: 'Movimiento registrado',
            id: result.insertId,
        });
    } catch (e) {
        console.error('[companyInvestment.addReturn]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// POST /api/admin/company-investments/:id/close
// Cierra una inversión de empresa (status = 'closed').
// ───────────────────────────────────────────────────────────────────────
exports.close = async (req, res) => {
    try {
        const { id } = req.params;
        const [invRows] = await pool.execute(
            `SELECT id, status FROM company_investments WHERE id = ?`, [id]
        );
        if (!invRows.length) return res.status(404).json({ error: 'Inversión no encontrada' });
        if (invRows[0].status === 'closed') {
            return res.status(400).json({ error: 'La inversión ya está cerrada' });
        }

        await pool.execute(
            `UPDATE company_investments SET status = 'closed', closed_at = NOW() WHERE id = ?`,
            [id]
        );
        res.json({ message: 'Inversión cerrada' });
    } catch (e) {
        console.error('[companyInvestment.close]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// POST /api/admin/company-investments/:id/reopen
// Reabre una inversión cerrada (status = 'active').
// ───────────────────────────────────────────────────────────────────────
exports.reopen = async (req, res) => {
    try {
        const { id } = req.params;
        const [invRows] = await pool.execute(
            `SELECT id, status FROM company_investments WHERE id = ?`, [id]
        );
        if (!invRows.length) return res.status(404).json({ error: 'Inversión no encontrada' });

        await pool.execute(
            `UPDATE company_investments SET status = 'active', closed_at = NULL WHERE id = ?`,
            [id]
        );
        res.json({ message: 'Inversión reabierta' });
    } catch (e) {
        console.error('[companyInvestment.reopen]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

// ───────────────────────────────────────────────────────────────────────
// DELETE /api/admin/company-investments/:id/returns/:returnId
// Elimina un rendimiento/venta puntual (por si se registró mal).
// ───────────────────────────────────────────────────────────────────────
exports.deleteReturn = async (req, res) => {
    try {
        const { id, returnId } = req.params;
        const [result] = await pool.execute(
            `DELETE FROM company_investment_returns WHERE id = ? AND company_investment_id = ?`,
            [returnId, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Movimiento no encontrado' });
        }
        res.json({ message: 'Movimiento eliminado' });
    } catch (e) {
        console.error('[companyInvestment.deleteReturn]', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};