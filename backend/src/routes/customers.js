const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, phone, email, company_name, customer_type } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { rows } = await pool.query(
      `INSERT INTO customers (name, phone, email, company_name, customer_type)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, phone || null, email || null, company_name || null, customer_type || 'individual']
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
