const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { checkDuplicatePnr } = require('../services/duplicatePnr');

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

router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['pnr', 'passenger_names', 'sale_price_per_seat', 'cost_price_per_seat', 'booking_status'];
    const updates = [];
    const params = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        params.push(field === 'passenger_names' ? JSON.stringify(req.body[field]) : req.body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE bookings SET ${updates.join(', ')}, updated_at = now()
       WHERE id = $${params.length} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [booking] } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }

    if (booking.block_id && booking.booking_status === 'confirmed') {
      await client.query(
        'UPDATE airline_blocks SET seats_sold = seats_sold - $1, updated_at = now() WHERE id = $2',
        [booking.seats_booked, booking.block_id]
      );
    }
    await client.query('DELETE FROM payments WHERE booking_id = $1', [req.params.id]);
    await client.query('DELETE FROM sales_register WHERE booking_id = $1', [req.params.id]);
    await client.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { cancellation_type, cancellation_fee, reason } = req.body;
    if (!['FOC', 'PAID', 'IROP'].includes(cancellation_type)) {
      return res.status(400).json({ error: 'cancellation_type must be FOC, PAID, or IROP' });
    }

    await client.query('BEGIN');
    const { rows: [booking] } = await client.query(
      'SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (!booking) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }
    if (booking.booking_status !== 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only a confirmed booking can be cancelled' });
    }

    const fee = cancellation_type === 'PAID' ? Math.max(0, Number(cancellation_fee) || 0) : 0;
    const refundAmount = Math.max(0, Number(booking.total_sale_amount) - fee);

    await client.query(
      `UPDATE bookings SET booking_status = 'cancelled', updated_at = now() WHERE id = $1`,
      [req.params.id]
    );
    await client.query(
      `UPDATE sales_register SET payment_status = 'refunded' WHERE booking_id = $1`,
      [req.params.id]
    );

    const { rows: [cancellation] } = await client.query(
      `INSERT INTO cancellations (booking_id, customer_id, cancellation_type, cancellation_fee, reason, cancelled_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, booking.customer_id, cancellation_type, fee, reason || null, req.user.id]
    );
    const { rows: [refund] } = await client.query(
      `INSERT INTO refunds (cancellation_id, booking_id, customer_id, refund_amount, processed_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cancellation.id, req.params.id, booking.customer_id, refundAmount, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ cancellation, refund });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
