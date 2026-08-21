const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.post('/', async (req, res, next) => {
  try {
    const { booking_id, customer_id, amount, payment_mode } = req.body;
    if (!booking_id || !customer_id || !amount || !payment_mode) {
      return res.status(400).json({ error: 'booking_id, customer_id, amount, and payment_mode are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO payments (booking_id, customer_id, amount, payment_mode, received_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [booking_id, customer_id, amount, payment_mode, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
