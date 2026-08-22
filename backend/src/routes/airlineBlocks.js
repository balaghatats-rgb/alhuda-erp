const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireRole } = require('../middleware/auth');
const { suggestSellPrice } = require('../services/aiPricing');

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

router.post('/', requireRole(['admin', 'manager']), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      airline_id, flight_number, travel_date, total_seats, cost_per_seat, name_in_tl_deadline,
      return_date, return_flight_number,
      outbound_timing, return_timing,
      supplier, payment_due_date, remarks,
      group_pnr, outbound_sector_route, return_sector_route
    } = req.body;

    if (!airline_id || !flight_number || !outbound_sector_route || !travel_date || !total_seats || cost_per_seat == null) {
      return res.status(400).json({ error: 'Missing required block fields' });
    }

    const outSegs = outbound_sector_route.split('-').map(s => s.trim().toUpperCase()).filter(Boolean);
    const sector_from = outSegs[0];
    const sector_to = outSegs[outSegs.length - 1];
    let return_sector_from = null, return_sector_to = null;
    if (return_sector_route) {
      const retSegs = return_sector_route.split('-').map(s => s.trim().toUpperCase()).filter(Boolean);
      return_sector_from = retSegs[0];
      return_sector_to = retSegs[retSegs.length - 1];
    }

    await client.query('BEGIN');

    const { rows: [{ count }] } = await client.query('SELECT count(*) FROM airline_blocks');
    const block_ref = req.body.block_ref || `BLK-${new Date().getFullYear()}-${String(Number(count) + 1).padStart(4, '0')}`;

    const { rows } = await client.query(
      `INSERT INTO airline_blocks
        (block_ref, group_pnr, airline_id, flight_number, sector_from, sector_to, outbound_sector_route, travel_date,
         total_seats, cost_per_seat, name_in_tl_deadline, created_by,
         return_date, return_sector_from, return_sector_to, return_sector_route, return_flight_number,
         outbound_timing, return_timing,
         supplier, payment_due_date, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [block_ref, group_pnr || null, airline_id, flight_number, sector_from, sector_to, outbound_sector_route, travel_date,
       total_seats, cost_per_seat, name_in_tl_deadline || null, req.user.id,
       return_date || null, return_sector_from, return_sector_to, return_sector_route || null, return_flight_number || null,
       outbound_timing || null, return_timing || null,
       supplier || null, payment_due_date || null, remarks || null]
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

router.patch('/:id', requireRole(['admin', 'manager']), async (req, res, next) => {
  try {
    const allowedFields = [
      'total_seats', 'cost_per_seat', 'name_in_tl_deadline', 'status',
      'flight_number', 'return_flight_number', 'outbound_sector_route', 'return_sector_route',
      'travel_date', 'return_date', 'outbound_timing', 'return_timing',
      'group_pnr', 'supplier', 'payment_due_date', 'remarks'
    ];
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

router.delete('/:id', requireRole(['admin', 'manager']), async (req, res, next) => {
  try {
    const { rows: [block] } = await pool.query('SELECT seats_sold FROM airline_blocks WHERE id = $1', [req.params.id]);
    if (!block) return res.status(404).json({ error: 'Block not found' });
    if (block.seats_sold > 0) {
      return res.status(400).json({ error: 'Cannot delete a block with existing bookings — cancel those bookings first.' });
    }
    await pool.query('DELETE FROM airline_blocks WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

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
