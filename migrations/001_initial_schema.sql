-- Airtime Vending System: durable order and callback records.
-- Apply once DATABASE_URL is configured for the Render web service.

CREATE TABLE IF NOT EXISTS airtime_orders (
  id UUID PRIMARY KEY,
  order_reference TEXT NOT NULL UNIQUE,
  network TEXT NOT NULL CHECK (network IN ('SAFARICOM','AIRTEL')),
  recipient_phone TEXT NOT NULL,
  amount_kes NUMERIC(12,2) NOT NULL CHECK (amount_kes >= 10 AND amount_kes <= 10000),
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
    CHECK (status IN ('PENDING_PAYMENT','PAID','AIRTIME_SUBMITTED','DELIVERED','FAILED','REVIEW')),
  mpesa_receipt_number TEXT UNIQUE,
  mpesa_transaction_id TEXT UNIQUE,
  airtime_provider_request_id TEXT,
  airtime_provider_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS airtime_orders_status_created_idx
  ON airtime_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_callbacks (
  id BIGSERIAL PRIMARY KEY,
  callback_fingerprint TEXT NOT NULL UNIQUE,
  mpesa_receipt_number TEXT,
  transaction_id TEXT,
  amount_kes NUMERIC(12,2),
  raw_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS airtime_callbacks (
  id BIGSERIAL PRIMARY KEY,
  callback_fingerprint TEXT NOT NULL UNIQUE,
  provider_request_id TEXT,
  provider_status TEXT,
  raw_payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS airtime_delivery_attempts (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES airtime_orders(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','SUBMITTED','DELIVERED','FAILED','UNKNOWN')),
  response_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
