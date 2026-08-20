const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

/**
 * POST /api/auth/setup
 * One-time endpoint to create your very first admin user. Only works if
 * NO staff exist yet — after that it always returns 403, so it can't be
 * used to create extra admins later (use /api/auth/register for that,
 * logged in as an existing admin).
 */
router.post('/setup', async (req, res, next) => {
  try {
    const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM staff');
    if (Number(count) > 0) {
      return res.status(403).json({ error: 'Setup already completed. Use /api/auth/login instead.' });
    }

    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO staff (name, email, password_hash, role) VALUES ($1,$2,$3,'admin')
       RETURNING id, name, email, role`,
      [name, email, password_hash]
    );

    const token = jwt.sign(
      { id: rows[0].id, role: rows[0].role, name: rows[0].name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({ user: rows[0], token });
  } catch (err) { next(err); }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await pool.query('SELECT * FROM staff WHERE email = $1 AND is_active = TRUE', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, token });
  } catch (err) { next(err); }
});

module.exports = router;
