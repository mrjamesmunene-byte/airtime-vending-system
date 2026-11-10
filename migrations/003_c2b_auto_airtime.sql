-- Permit direct Till payments to route airtime by the payer's MSISDN.
ALTER TABLE airtime_orders DROP CONSTRAINT IF EXISTS airtime_orders_network_check;
ALTER TABLE airtime_orders
  ADD CONSTRAINT airtime_orders_network_check
  CHECK (network IN ('SAFARICOM','AIRTEL','AUTO'));

-- sendAirtime claims a paid order with this intermediate status before calling
-- the airtime provider; include it in the order-state constraint.
ALTER TABLE airtime_orders DROP CONSTRAINT IF EXISTS airtime_orders_status_check;
ALTER TABLE airtime_orders
  ADD CONSTRAINT airtime_orders_status_check
  CHECK (status IN ('PENDING_PAYMENT','PAID','AIRTIME_SUBMITTED','DELIVERED','FAILED','REVIEW'));
