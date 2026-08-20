/**
 * GOOGLE SHEETS SYNC
 *
 * Every INSERT/UPDATE/DELETE on airline_blocks, bookings, sales_register,
 * and payments is queued into `sheets_sync_queue` by a Postgres trigger
 * (see database/schema.sql, fn_audit_and_queue_sync). This worker polls
 * that queue and mirrors each change into the matching Google Sheet tab,
 * so Sheets is always a real-time reflection of the ERP — never a manual export.
 *
 * Setup required (see README.md):
 *   1. Create a Google Cloud service account, enable the Sheets API.
 *   2. Share your target spreadsheet with the service account's email.
 *   3. Put the service account JSON key path in GOOGLE_APPLICATION_CREDENTIALS
 *      and the spreadsheet ID in GOOGLE_SHEET_ID (see .env.example).
 */
const { google } = require('googleapis');
const { pool } = require('../db');

const SHEET_TAB_MAP = {
  airline_blocks: 'Airline Blocks',
  bookings: 'Bookings',
  sales_register: 'Sales Register',
  payments: 'Payments',
};

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

/**
 * Upserts a row into the sheet by matching column A (the record's UUID).
 * DELETE actions clear the row's values but keep the row position, so
 * row numbers referenced elsewhere in the sheet (e.g. a dashboard formula)
 * don't shift unexpectedly.
 */
async function upsertRow(sheets, spreadsheetId, tab, record) {
  const range = `${tab}!A:Z`;
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = existing.data.values || [];
  const headerRow = rows[0] || Object.keys(record);
  const idColIndex = 0; // column A = id, by convention across every tab

  const rowIndex = rows.findIndex((r, i) => i > 0 && r[idColIndex] === record.id);
  const values = headerRow.map((col) => stringifyCell(record[col]));

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
  }
}

async function clearRow(sheets, spreadsheetId, tab, id) {
  const range = `${tab}!A:Z`;
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = existing.data.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === id);
  if (rowIndex === -1) return;
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A${rowIndex + 1}:Z${rowIndex + 1}` });
}

function stringifyCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Drains up to `batchSize` pending sync events per tick. Marks each as
 * synced only after a successful write, so a Sheets API hiccup just
 * delays the next tick's retry rather than losing the event.
 */
async function processQueueBatch(batchSize = 25) {
  const { rows: pending } = await pool.query(
    `SELECT * FROM sheets_sync_queue WHERE synced = FALSE ORDER BY id ASC LIMIT $1`,
    [batchSize]
  );
  if (!pending.length) return;

  const sheets = await getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  for (const event of pending) {
    const tab = SHEET_TAB_MAP[event.table_name];
    if (!tab) { await markSynced(event.id); continue; }

    try {
      if (event.action === 'DELETE') {
        await clearRow(sheets, spreadsheetId, tab, event.record_id);
      } else {
        await upsertRow(sheets, spreadsheetId, tab, { id: event.record_id, ...event.payload });
      }
      await markSynced(event.id);
    } catch (err) {
      // Leave unsynced — will retry next tick. Log for visibility/alerting.
      console.error(`Sheets sync failed for queue item ${event.id} (${event.table_name}):`, err.message);
      break; // stop this batch on first failure to preserve ordering per tick
    }
  }
}

async function markSynced(queueId) {
  await pool.query('UPDATE sheets_sync_queue SET synced = TRUE, synced_at = now() WHERE id = $1', [queueId]);
}

function startSyncWorker(intervalMs = 5000) {
  setInterval(() => {
    processQueueBatch().catch((err) => console.error('Sync worker tick failed:', err));
  }, intervalMs);
  console.log(`Google Sheets sync worker started (every ${intervalMs / 1000}s)`);
}

module.exports = { startSyncWorker, processQueueBatch };
