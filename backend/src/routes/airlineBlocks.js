const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole } = require('../middleware/auth');
const { suggestSellPrice } = require('../services/aiPricing');

/**
 * GET /api/airline-blocks
 * Live availability across all blocks — powers the Airline Block Master grid
 * and the dashboard's "seats remaining" widgets. Supports filters.
 */
router.get('/', async (req, res, next) => {
  try {
    const { status, airline, from_date, to_date } = req.query;
    const conditions = [];
    const params = [];

    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (airline) { params.push(airline); conditions.push(`iata_code = $${params.length}`); }
    if (from_date) { params.push(from_date); conditions.push(`travel_date >= $${params.length}`); }
    if (to_date) { params.push(to_date); conditions.push(`travel_date <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM v_block_availability ${where} ORDER BY travel_date ASC`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * POST /api/airline-blocks
 * Create a new block. Auto-generates block_ref if not supplied and
 * returns an AI-suggested sell price based on historical fares for
 * the same sector (see services/aiPricing.js).
 */
router.post('/', requireRole(['admin', 'manager']), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      airline_id, flight_number, sector_from, sector_to,
      travel_date, total_seats, cost_per_seat, name_in_tl_deadline
    } = req.body;

    if (!airline_id || !flight_number || !sector_from || !sector_to || !travel_date || !total_seats || cost_per_seat == null) {
      return res.status(400).json({ error: 'Missing required block fields' });
    }

    await client.query('BEGIN');

    const { rows: [{ count }] } = await client.query('SELECT count(*) FROM airline_blocks');
    const block_ref = req.body.block_ref || `BLK-${new Date().getFullYear()}-${String(Number(count) + 1).padStart(4, '0')}`;

    const { rows } = await client.query(
      `INSERT INTO airline_blocks
        (block_ref, airline_id, flight_number, sector_from, sector_to, travel_date,
         total_seats, cost_per_seat, name_in_tl_deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [block_ref, airline_id, flight_number, sector_from, sector_to, travel_date,
       total_seats, cost_per_seat, name_in_tl_deadline || null, req.user.id]
    );

    const suggestedPrice = await suggestSellPrice(client, { sector_from, sector_to, cost_per_seat });
    await client.query('UPDATE airline_blocks SET suggested_sell_price = $1 WHERE id = $2',
      [suggestedPrice, rows[0].id]);

    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], suggested_sell_price: suggestedPrice });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/airline-blocks/:id
 * Edit block details (e.g. extend name-in-TL deadline, close a block).
 */
router.patch('/:id', requireRole(['admin', 'manager']), async (req, res, next) => {
  try {
    const allowedFields = ['total_seats', 'cost_per_seat', 'name_in_tl_deadline', 'status'];
    const updates = [];
    const params = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        params.push(req.body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE airline_blocks SET ${updates.join(', ')}, updated_at = now()
       WHERE id = $${params.length} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Block not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/**
 * GET /api/airline-blocks/alerts/name-deadlines
 * Blocks whose name-in-TL deadline is within N days and still has unsold seats —
 * feeds the dashboard's "smart reminders" panel.
 */
router.get('/alerts/name-deadlines', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '5', 10);
    const { rows } = await pool.query(
      `SELECT * FROM v_block_availability
       WHERE name_in_tl_deadline IS NOT NULL
         AND name_in_tl_deadline <= CURRENT_DATE + $1::int
         AND status = 'open'
       ORDER BY name_in_tl_deadline ASC`,
      [days]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
