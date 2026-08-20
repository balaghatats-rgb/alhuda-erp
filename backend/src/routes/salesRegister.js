const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/**
 * GET /api/sales-register
 * The consolidated, always-accurate sales ledger. Never written to directly —
 * every row here was created automatically by the booking trigger, so this
 * endpoint can never drift out of sync with actual bookings.
 */
router.get('/', async (req, res, next) => {
  try {
    const { payment_status, from_date, to_date } = req.query;
    const conditions = [];
    const params = [];
    if (payment_status) { params.push(payment_status); conditions.push(`sr.payment_status = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`sr.sale_date >= $${params.length}`); }
    if (to_date) { params.push(to_date); conditions.push(`sr.sale_date <= $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT sr.*, b.pnr, b.booking_type, c.name AS customer_name
       FROM sales_register sr
       JOIN bookings b ON b.id = sr.booking_id
       JOIN customers c ON c.id = b.customer_id
       ${where}
       ORDER BY sr.sale_date DESC`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * GET /api/sales-register/summary
 * Powers the dashboard's revenue / outstanding / profit tiles.
 */
router.get('/summary', async (req, res, next) => {
  try {
    const { rows: [summary] } = await pool.query(`
      SELECT
        COALESCE(SUM(sr.amount_billed), 0) AS total_revenue,
        COALESCE(SUM(sr.amount_received), 0) AS total_received,
        COALESCE(SUM(sr.amount_due), 0) AS total_outstanding,
        COALESCE(SUM(b.profit_amount), 0) AS total_profit,
        COUNT(*) FILTER (WHERE sr.payment_status = 'unpaid') AS unpaid_invoices,
        COUNT(*) FILTER (WHERE sr.payment_status = 'partial') AS partial_invoices
      FROM sales_register sr
      JOIN bookings b ON b.id = sr.booking_id
    `);
    res.json(summary);
  } catch (err) { next(err); }
});

module.exports = router;
