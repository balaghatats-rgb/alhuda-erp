-- ============================================================================
-- AL HUDA TRAVELS ERP - Module 1: Airline Block Master + Sales Register
-- PostgreSQL 14+
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- STAFF (referenced by created_by / staff performance)
-- ----------------------------------------------------------------------------
CREATE TABLE staff (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(120) NOT NULL,
    email           VARCHAR(150) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(30) NOT NULL DEFAULT 'staff'
                    CHECK (role IN ('admin','manager','staff','accounts','viewer')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- CUSTOMERS
-- ----------------------------------------------------------------------------
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(150) NOT NULL,
    phone           VARCHAR(30),
    email           VARCHAR(150),
    company_name    VARCHAR(150),
    customer_type   VARCHAR(20) NOT NULL DEFAULT 'individual'
                    CHECK (customer_type IN ('individual','corporate','sub_agent')),
    credit_limit    NUMERIC(14,2) DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- AIRLINES (for color-coded flight number formatting on the dashboard)
-- ----------------------------------------------------------------------------
CREATE TABLE airlines (
    id              SERIAL PRIMARY KEY,
    iata_code       VARCHAR(3) UNIQUE NOT NULL,      -- e.g. '6E', 'AI', 'SV'
    name            VARCHAR(100) NOT NULL,
    color_hex       VARCHAR(7) NOT NULL DEFAULT '#6b7280'  -- used by dashboard badges
);

-- ----------------------------------------------------------------------------
-- AIRLINE BLOCK MASTER
-- One row = one block of seats purchased from an airline on a sector/date
-- ----------------------------------------------------------------------------
CREATE TABLE airline_blocks (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    block_ref           VARCHAR(30) UNIQUE NOT NULL,      -- internal reference e.g. BLK-2026-0091
    airline_id          INT NOT NULL REFERENCES airlines(id),
    flight_number       VARCHAR(10) NOT NULL,
    sector_from          VARCHAR(5) NOT NULL,             -- IATA airport code
    sector_to            VARCHAR(5) NOT NULL,
    travel_date          DATE NOT NULL,
    total_seats          INT NOT NULL CHECK (total_seats > 0),
    seats_sold            INT NOT NULL DEFAULT 0,
    cost_per_seat         NUMERIC(12,2) NOT NULL CHECK (cost_per_seat >= 0),
    suggested_sell_price   NUMERIC(12,2),                 -- AI pricing suggestion can write here
    name_in_tl_deadline   DATE,                            -- deadline for submitting passenger names to airline
    status                VARCHAR(20) NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','closed','cancelled','flown')),
    created_by            UUID REFERENCES staff(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT seats_sold_within_total CHECK (seats_sold <= total_seats)
);

CREATE INDEX idx_blocks_travel_date ON airline_blocks(travel_date);
CREATE INDEX idx_blocks_status ON airline_blocks(status);

-- Convenience view: seats remaining, computed not stored (never goes stale)
CREATE VIEW v_block_availability AS
SELECT
    b.id, b.block_ref, a.iata_code, a.name AS airline_name, a.color_hex,
    b.flight_number, b.sector_from, b.sector_to, b.travel_date,
    b.total_seats, b.seats_sold, (b.total_seats - b.seats_sold) AS seats_remaining,
    ROUND(b.seats_sold::numeric / NULLIF(b.total_seats,0) * 100, 1) AS pct_sold,
    b.cost_per_seat, b.name_in_tl_deadline, b.status
FROM airline_blocks b
JOIN airlines a ON a.id = b.airline_id;

-- ----------------------------------------------------------------------------
-- BOOKINGS (block seats, FIT, or group — all bookings funnel through here)
-- ----------------------------------------------------------------------------
CREATE TABLE bookings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_type        VARCHAR(10) NOT NULL DEFAULT 'BLOCK'
                        CHECK (booking_type IN ('BLOCK','FIT','GROUP')),
    block_id            UUID REFERENCES airline_blocks(id),   -- NULL for pure FIT
    pnr                 VARCHAR(10) NOT NULL,
    customer_id         UUID NOT NULL REFERENCES customers(id),
    passenger_names     JSONB NOT NULL DEFAULT '[]',
    seats_booked         INT NOT NULL CHECK (seats_booked > 0),
    sale_price_per_seat  NUMERIC(12,2) NOT NULL,
    cost_price_per_seat  NUMERIC(12,2) NOT NULL,
    total_sale_amount     NUMERIC(14,2) GENERATED ALWAYS AS (sale_price_per_seat * seats_booked) STORED,
    total_cost_amount     NUMERIC(14,2) GENERATED ALWAYS AS (cost_price_per_seat * seats_booked) STORED,
    profit_amount          NUMERIC(14,2) GENERATED ALWAYS AS
                            ((sale_price_per_seat - cost_price_per_seat) * seats_booked) STORED,
    booking_status         VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                           CHECK (booking_status IN ('confirmed','cancelled','refunded')),
    staff_id                UUID REFERENCES staff(id),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_pnr ON bookings(pnr);
CREATE INDEX idx_bookings_block ON bookings(block_id);
CREATE INDEX idx_bookings_customer ON bookings(customer_id);
-- Flags true duplicate PNR entry against the SAME block (the AI duplicate-PNR check
-- in the backend also runs a fuzzy cross-block check — see duplicatePnr.js)
CREATE UNIQUE INDEX uq_pnr_per_block ON bookings(block_id, pnr) WHERE block_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- SALES REGISTER — auto-populated ledger, never written to directly by users
-- ----------------------------------------------------------------------------
CREATE TABLE sales_register (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id           UUID NOT NULL UNIQUE REFERENCES bookings(id),
    invoice_no             VARCHAR(30) UNIQUE NOT NULL,
    sale_date               DATE NOT NULL DEFAULT CURRENT_DATE,
    amount_billed             NUMERIC(14,2) NOT NULL,
    amount_received            NUMERIC(14,2) NOT NULL DEFAULT 0,
    amount_due                  NUMERIC(14,2) GENERATED ALWAYS AS (amount_billed - amount_received) STORED,
    payment_status                VARCHAR(20) NOT NULL DEFAULT 'unpaid'
                                  CHECK (payment_status IN ('unpaid','partial','paid')),
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- PAYMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id      UUID NOT NULL REFERENCES bookings(id),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    payment_mode    VARCHAR(20) NOT NULL CHECK (payment_mode IN ('cash','bank','card','cheque','online')),
    payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    received_by     UUID REFERENCES staff(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- AUDIT LOG
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    table_name      VARCHAR(50) NOT NULL,
    record_id       UUID NOT NULL,
    action          VARCHAR(10) NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
    changed_by      UUID REFERENCES staff(id),
    old_data        JSONB,
    new_data        JSONB,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- GOOGLE SHEETS SYNC QUEUE
-- Every create/update/delete that must reach Sheets lands here first.
-- A background worker (see backend/src/services/googleSheetsSync.js) drains it.
-- This decouples the API response from Sheets' rate limits/latency.
-- ----------------------------------------------------------------------------
CREATE TABLE sheets_sync_queue (
    id              BIGSERIAL PRIMARY KEY,
    table_name      VARCHAR(50) NOT NULL,
    record_id       UUID NOT NULL,
    action          VARCHAR(10) NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
    payload         JSONB NOT NULL,
    synced          BOOLEAN NOT NULL DEFAULT FALSE,
    synced_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_queue_pending ON sheets_sync_queue(synced) WHERE synced = FALSE;

-- ============================================================================
-- TRIGGERS — this is what makes "enter once, updates everywhere" actually true
-- ============================================================================

-- 1. When a booking is inserted/cancelled, keep airline_blocks.seats_sold correct
CREATE OR REPLACE FUNCTION fn_update_block_seats() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.block_id IS NOT NULL AND NEW.booking_status = 'confirmed' THEN
        UPDATE airline_blocks SET seats_sold = seats_sold + NEW.seats_booked, updated_at = now()
        WHERE id = NEW.block_id;

    ELSIF TG_OP = 'UPDATE' AND NEW.block_id IS NOT NULL THEN
        IF OLD.booking_status = 'confirmed' AND NEW.booking_status IN ('cancelled','refunded') THEN
            UPDATE airline_blocks SET seats_sold = seats_sold - OLD.seats_booked, updated_at = now()
            WHERE id = NEW.block_id;
        ELSIF OLD.booking_status != 'confirmed' AND NEW.booking_status = 'confirmed' THEN
            UPDATE airline_blocks SET seats_sold = seats_sold + NEW.seats_booked, updated_at = now()
            WHERE id = NEW.block_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_block_seats
AFTER INSERT OR UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION fn_update_block_seats();

-- 2. When a booking is inserted, auto-create its Sales Register entry
CREATE OR REPLACE FUNCTION fn_create_sales_register_entry() RETURNS TRIGGER AS $$
DECLARE
    v_invoice VARCHAR(30);
BEGIN
    v_invoice := 'INV-' || to_char(now(), 'YYYY') || '-' ||
                 lpad(nextval('sales_register_invoice_seq')::text, 5, '0');
    INSERT INTO sales_register (booking_id, invoice_no, amount_billed, payment_status)
    VALUES (NEW.id, v_invoice, NEW.total_sale_amount, 'unpaid');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE SEQUENCE sales_register_invoice_seq START 1;

CREATE TRIGGER trg_create_sales_register
AFTER INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION fn_create_sales_register_entry();

-- 3. When a payment is recorded, update sales_register.amount_received + status
CREATE OR REPLACE FUNCTION fn_apply_payment() RETURNS TRIGGER AS $$
DECLARE
    v_billed NUMERIC(14,2);
    v_new_received NUMERIC(14,2);
BEGIN
    UPDATE sales_register
    SET amount_received = amount_received + NEW.amount
    WHERE booking_id = NEW.booking_id
    RETURNING amount_billed, amount_received INTO v_billed, v_new_received;

    UPDATE sales_register
    SET payment_status = CASE
        WHEN v_new_received >= v_billed THEN 'paid'
        WHEN v_new_received > 0 THEN 'partial'
        ELSE 'unpaid'
    END
    WHERE booking_id = NEW.booking_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_payment
AFTER INSERT ON payments
FOR EACH ROW EXECUTE FUNCTION fn_apply_payment();

-- 4. Generic audit log + Sheets sync queue trigger, applied to key tables
CREATE OR REPLACE FUNCTION fn_audit_and_queue_sync() RETURNS TRIGGER AS $$
DECLARE
    v_record_id UUID;
    v_payload JSONB;
BEGIN
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_payload := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

    INSERT INTO audit_log(table_name, record_id, action, old_data, new_data)
    VALUES (TG_TABLE_NAME, v_record_id, TG_OP,
            CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) END);

    INSERT INTO sheets_sync_queue(table_name, record_id, action, payload)
    VALUES (TG_TABLE_NAME, v_record_id, TG_OP, v_payload);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_blocks
AFTER INSERT OR UPDATE OR DELETE ON airline_blocks
FOR EACH ROW EXECUTE FUNCTION fn_audit_and_queue_sync();

CREATE TRIGGER trg_audit_bookings
AFTER INSERT OR UPDATE OR DELETE ON bookings
FOR EACH ROW EXECUTE FUNCTION fn_audit_and_queue_sync();

CREATE TRIGGER trg_audit_sales_register
AFTER INSERT OR UPDATE OR DELETE ON sales_register
FOR EACH ROW EXECUTE FUNCTION fn_audit_and_queue_sync();

CREATE TRIGGER trg_audit_payments
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION fn_audit_and_queue_sync();

-- ============================================================================
-- Seed data: a couple of airlines for color-coded badges
-- ============================================================================
INSERT INTO airlines (iata_code, name, color_hex) VALUES
    ('6E', 'IndiGo', '#0f3b82'),
    ('AI', 'Air India', '#c0392b'),
    ('SV', 'Saudia', '#0f6d3e'),
    ('EK', 'Emirates', '#b8860b'),
    ('SG', 'SpiceJet', '#d1471c');
