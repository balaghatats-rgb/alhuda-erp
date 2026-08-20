/**
 * AL HUDA TRAVELS ERP — Backend Entry Point
 * Module 1: Airline Block Master + Sales Register
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const airlineBlocksRoutes = require('./routes/airlineBlocks');
const bookingsRoutes = require('./routes/bookings');
const salesRegisterRoutes = require('./routes/salesRegister');
const authMiddleware = require('./middleware/auth');
const { startSyncWorker } = require('./services/googleSheetsSync');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 300 })); // basic API abuse protection

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'alhuda-erp-backend' }));

// All ERP routes require a valid JWT (role-based checks happen inside each route)
app.use('/api/airline-blocks', authMiddleware, airlineBlocksRoutes);
app.use('/api/bookings', authMiddleware, bookingsRoutes);
app.use('/api/sales-register', authMiddleware, salesRegisterRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Al Huda ERP backend running on port ${PORT}`);
  // Drains sheets_sync_queue every few seconds and pushes rows to Google Sheets.
  // Runs in-process here for simplicity; move to a separate worker process in production.
  startSyncWorker();
});

module.exports = app;
