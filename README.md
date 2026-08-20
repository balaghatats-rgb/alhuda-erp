# Al Huda Travels ERP — Module 1: Airline Block Master + Sales Register

This is a complete, working slice of the full ERP: create an airline block →
sell seats against it → the block's remaining seats, the Sales Register
ledger, payment status, and Google Sheets all update automatically from a
single API call. This is the pattern every other module (Umrah/Hajj, Hotels,
Holiday Packages, Visa, CRM...) should follow.

## What's included

| File | Purpose |
|---|---|
| `database/schema.sql` | Full Postgres schema: blocks, bookings, sales register, payments, audit log, Sheets sync queue — plus the triggers that keep them all in sync automatically |
| `backend/src/routes/airlineBlocks.js` | Create/list/update blocks, AI sell-price suggestion, name-in-TL deadline alerts |
| `backend/src/routes/bookings.js` | Sell seats against a block or FIT, with AI duplicate-PNR detection and seat-availability locking |
| `backend/src/routes/salesRegister.js` | Auto-generated ledger + dashboard summary (revenue, outstanding, profit) |
| `backend/src/services/googleSheetsSync.js` | Background worker that mirrors every change into Google Sheets in real time |
| `backend/src/services/aiPricing.js` | AI sell-price suggestion based on historical margins per sector |
| `backend/src/services/duplicatePnr.js` | Flags duplicate/near-duplicate PNRs |
| `backend/src/middleware/auth.js` | JWT auth + role-based access control |

## Why data only needs to be entered once

Postgres triggers do the cross-module work, not application code:
- Inserting a **booking** automatically decrements the block's available
  seats, creates its **Sales Register** invoice, and queues both for
  **Google Sheets** — in one transaction.
- Recording a **payment** automatically updates the invoice's paid/partial/
  unpaid status.
- Every insert/update/delete on the key tables writes to `audit_log` and
  `sheets_sync_queue` automatically — no route ever has to remember to do
  this by hand, so it can't be forgotten as new modules get added.

## Running it locally

```bash
# 1. Database
createdb alhuda_erp
psql alhuda_erp -f database/schema.sql

# 2. Backend
cd backend
cp .env.example .env    # fill in DATABASE_URL, JWT_SECRET, Google Sheets creds
npm install
npm run dev
```

Then `POST /api/airline-blocks` to create a block, `POST /api/bookings` to
sell seats against it, and watch `GET /api/sales-register/summary` and your
Google Sheet update automatically.

## Setting up the Google Sheets side

1. In Google Cloud Console, create a service account and enable the
   Google Sheets API.
2. Download its JSON key and point `GOOGLE_APPLICATION_CREDENTIALS` at it.
3. Create a spreadsheet with tabs named exactly: `Airline Blocks`,
   `Bookings`, `Sales Register`, `Payments` — with a header row whose
   column names match the database columns.
4. Share the spreadsheet with the service account's email as **Editor**.
5. Put the spreadsheet ID (from its URL) in `GOOGLE_SHEET_ID`.

## Extending this to the rest of the ERP

Each remaining module (Visa, Umrah/Hajj, Hotels, Holiday Packages, CRM,
Corporate Travel, Staff/User Management) follows the same three-part
pattern used here:
1. Add its tables to `schema.sql`, with the same `trg_audit_and_queue_sync`
   trigger attached.
2. Add its route file under `backend/src/routes/`.
3. Add its tab name to `SHEET_TAB_MAP` in `googleSheetsSync.js`.

The HTML live dashboard and the AI query interface ("How many IndiGo seats
remain unsold this week?") both read from the same tables/views this module
already created (`v_block_availability`, `sales_register`), so they can be
built next without changing anything here.

## Not included in this slice (flagged honestly)

- Frontend (Next.js) pages — a working demo of the UI is provided separately
  as an interactive prototype; production pages would call these same APIs.
- WhatsApp/email notification delivery (the *data* those alerts need —
  name-in-TL deadlines, outstanding payments — is already queryable via
  `/api/airline-blocks/alerts/name-deadlines` and `/api/sales-register`).
- 2FA — straightforward to add to `middleware/auth.js` with a library like
  `speakeasy`, intentionally left out to keep this module focused.
