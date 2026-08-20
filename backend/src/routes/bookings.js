const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { checkDuplicatePnr } = require('../services/duplicatePnr');

/**
 * POST /api/bookings
 * Creates a booking against a block (or FIT). This single insert is what
 * cascades everywhere: DB triggers decrement block seats, create the
 * Sales Register invoice, and queue the row for Google Sheets sync —
 * the caller does not need to touch any other table.
 */
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      booking_type, block_id, pnr, customer_id, passenger_names,
      seats_booked, sale_price_per_seat, cost_price_per_seat
    } = req.body;

    if (!pnr || !customer_id || !seats_booked || sale_price_per_seat == null || cost_price_per_seat == null) {
      return res.status(400).json({ error: 'Missing required booking fields' });
    }

    // AI duplicate-PNR check: flags exact duplicates on the same block AND
    // near-duplicate PNRs across other open blocks that are likely data-entry errors.
    const dupWarning = await checkDuplicatePnr(pool, { pnr, block_id });
    if (dupWarning.exactDuplicate) {
      return res.status(409).json({ error: 'Duplicate PNR on this block', details: dupWarning });
    }

    await client.query('BEGIN');

    if (block_id) {
      const { rows: [block] } = await client.query(
        'SELECT total_seats, seats_sold, status FROM airline_blocks WHERE id = $1 FOR UPDATE', [block_id]
      );
      if (!block) throw Object.assign(new Error('Block not found'), { status: 404 });
      if (block.status !== 'open') throw Object.assign(new Error('Block is not open for booking'), { status: 400 });
      if (block.seats_sold + seats_booked > block.total_seats) {
        throw Object.assign(new Error(
          `Only ${block.total_seats - block.seats_sold} seats remaining on this block`
        ), { status: 400 });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO bookings
        (booking_type, block_id, pnr, customer_id, passenger_names,
         seats_booked, sale_price_per_seat, cost_price_per_seat, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [booking_type || 'BLOCK', block_id || null, pnr, customer_id,
       JSON.stringify(passenger_names || []), seats_booked,
       sale_price_per_seat, cost_price_per_seat, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({
      booking: rows[0],
      warning: dupWarning.similarPnrElsewhere ? dupWarning : undefined
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { block_id, customer_id } = req.query;
    const conditions = [];
    const params = [];
    if (block_id) { params.push(block_id); conditions.push(`block_id = $${params.length}`); }
    if (customer_id) { params.push(customer_id); conditions.push(`customer_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT * FROM bookings ${where} ORDER BY created_at DESC`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
