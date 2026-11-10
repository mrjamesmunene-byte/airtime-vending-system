-- Allow direct M-Pesa Till payments to route airtime using the recipient MSISDN.
-- Africa's Talking selects the destination mobile network from the phone number.
ALTER TABLE airtime_orders DROP CONSTRAINT IF EXISTS airtime_orders_network_check;
ALTER TABLE airtime_orders
  ADD CONSTRAINT airtime_orders_network_check
  CHECK (network IN ('SAFARICOM','AIRTEL','AUTO'));
