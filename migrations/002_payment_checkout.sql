-- Additional fields required for STK Push checkout and callback matching.
ALTER TABLE airtime_orders
  ADD COLUMN IF NOT EXISTS mpesa_checkout_request_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS mpesa_merchant_request_id TEXT,
  ADD COLUMN IF NOT EXISTS payer_phone TEXT;

CREATE INDEX IF NOT EXISTS airtime_orders_checkout_request_idx
  ON airtime_orders (mpesa_checkout_request_id)
  WHERE mpesa_checkout_request_id IS NOT NULL;
