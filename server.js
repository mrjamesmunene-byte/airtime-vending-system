const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const AT_USERNAME = process.env.AT_USERNAME;
const AT_API_KEY = process.env.AT_API_KEY;
const AT_BASE_URL = process.env.AT_BASE_URL || "https://api.sandbox.africastalking.com";
const MPESA_ENV = process.env.MPESA_ENV || "sandbox";
const MPESA_BASE_URL = MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  : null;

const money = value => Number(Number(value).toFixed(2));
const normalizePhone = value => {
  let p = String(value || "").replace(/[\s-]/g, "");
  if (p.startsWith("0")) p = "+254" + p.slice(1);
  if (p.startsWith("254")) p = "+" + p;
  return /^\+254[17]\d{8}$/.test(p) ? p : null;
};
const ref = () => "AV" + crypto.randomBytes(5).toString("hex").toUpperCase();
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function initializeDatabase() {
  if (!pool) return;
  const first = fs.readFileSync(path.join(__dirname, "migrations/001_initial_schema.sql"), "utf8");
  const second = fs.readFileSync(path.join(__dirname, "migrations/002_payment_checkout.sql"), "utf8");
  await pool.query(first);
  await pool.query(second);
  console.log("Database schema is ready.");
}

async function mpesaAccessToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) throw new Error("M-Pesa API credentials are not configured.");
  const auth = Buffer.from(key + ":" + secret).toString("base64");
  const response = await fetch(MPESA_BASE_URL + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + auth }
  });
  const data = await response.json().catch(() => ({}));
  console.info("M-Pesa OAuth check:", JSON.stringify({
    httpStatus: response.status,
    tokenReceived: Boolean(data.access_token),
    expiresIn: data.expires_in || null,
    environment: MPESA_ENV,
    errorCode: data.errorCode || null,
    errorMessage: data.errorMessage || null
  }));
  if (!response.ok || !data.access_token) throw new Error("Could not obtain M-Pesa access token.");
  return data.access_token;
}

async function sendAirtime(order) {
  if (process.env.LIVE_AIRTIME_ENABLED !== "true") {
    console.log("Payment verified; airtime held because LIVE_AIRTIME_ENABLED is not true. Order:", order.order_reference);
    return;
  }
  if (!AT_USERNAME || !AT_API_KEY) {
    await pool.query("UPDATE airtime_orders SET status='REVIEW', updated_at=NOW() WHERE id=$1", [order.id]);
    console.error("Airtime credentials missing; order moved to REVIEW:", order.order_reference);
    return;
  }

  // Claim the order before calling the provider so duplicate callbacks cannot send twice.
  const claimed = await pool.query(
    "UPDATE airtime_orders SET status='AIRTIME_SUBMITTED', updated_at=NOW() WHERE id=$1 AND status='PAID' RETURNING *",
    [order.id]
  );
  if (!claimed.rowCount) return;
  const claimedOrder = claimed.rows[0];
  const attempt = await pool.query(
    "INSERT INTO airtime_delivery_attempts (order_id,idempotency_key,status) VALUES ($1,$2,'CREATED') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id",
    [claimedOrder.id, "airtime-" + claimedOrder.id]
  );
  if (!attempt.rowCount) return;

  try {
    const form = new URLSearchParams();
    form.set("username", AT_USERNAME);
    form.set("recipients", JSON.stringify([{
      phoneNumber: claimedOrder.recipient_phone,
      amount: "KES " + money(claimedOrder.amount_kes).toFixed(2)
    }]));
    form.set("maxNumRetry", "0");
    const response = await fetch(AT_BASE_URL + "/version1/airtime/send", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", apiKey: AT_API_KEY },
      body: form.toString()
    });
    const result = await response.json().catch(() => ({}));
    const item = result.responses && result.responses[0];
    if (!response.ok || !item || item.status !== "Sent" || !item.requestId) {
      await pool.query("UPDATE airtime_orders SET status='REVIEW', airtime_provider_status=$2, updated_at=NOW() WHERE id=$1",
        [claimedOrder.id, item?.errorMessage || result.errorMessage || "Provider did not confirm submission"]);
      await pool.query("UPDATE airtime_delivery_attempts SET status='UNKNOWN', response_payload=$2, updated_at=NOW() WHERE id=$1",
        [attempt.rows[0].id, JSON.stringify(result)]);
      return;
    }
    await pool.query(
      "UPDATE airtime_orders SET airtime_provider_request_id=$2, airtime_provider_status='Sent', updated_at=NOW() WHERE id=$1",
      [claimedOrder.id, item.requestId]
    );
    await pool.query(
      "UPDATE airtime_delivery_attempts SET status='SUBMITTED', provider_request_id=$2, response_payload=$3, updated_at=NOW() WHERE id=$1",
      [attempt.rows[0].id, item.requestId, JSON.stringify(result)]
    );
    console.log("Airtime accepted by provider; final delivery callback still pending:", item.requestId);
  } catch (error) {
    await pool.query("UPDATE airtime_orders SET status='REVIEW', airtime_provider_status='Provider request outcome unknown', updated_at=NOW() WHERE id=$1",
      [claimedOrder.id]);
    await pool.query("UPDATE airtime_delivery_attempts SET status='UNKNOWN', updated_at=NOW() WHERE id=$1", [attempt.rows[0].id]);
    console.error("Airtime request outcome unknown; do not retry automatically:", error.message);
  }
}

async function recordPayment({ orderReference, receipt, amount, transactionId, payerPhone, payload }) {
  if (!pool) throw new Error("Database is not configured.");
  const client = await pool.connect();
  let paidOrder = null;
  try {
    await client.query("BEGIN");
    const orderResult = await client.query(
      "SELECT * FROM airtime_orders WHERE order_reference=$1 FOR UPDATE", [orderReference]
    );
    if (!orderResult.rowCount) {
      await client.query("ROLLBACK");
      return { outcome: "NO_MATCHING_ORDER" };
    }
    const order = orderResult.rows[0];
    if (money(order.amount_kes) !== money(amount)) {
      await client.query("UPDATE airtime_orders SET status='REVIEW', updated_at=NOW() WHERE id=$1", [order.id]);
      await client.query("COMMIT");
      return { outcome: "AMOUNT_MISMATCH" };
    }
    if (payerPhone && normalizePhone(payerPhone) !== normalizePhone(order.payer_phone)) {
      await client.query("UPDATE airtime_orders SET status='REVIEW', updated_at=NOW() WHERE id=$1", [order.id]);
      await client.query("COMMIT");
      return { outcome: "PAYER_PHONE_MISMATCH" };
    }
    if (order.status !== "PENDING_PAYMENT") {
      await client.query("COMMIT");
      return { outcome: "ALREADY_PROCESSED" };
    }
    const fp = fingerprint(payload);
    await client.query(
      "INSERT INTO payment_callbacks (callback_fingerprint,mpesa_receipt_number,transaction_id,amount_kes,raw_payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (callback_fingerprint) DO NOTHING",
      [fp, receipt || null, transactionId || null, amount, JSON.stringify(payload)]
    );
    const updated = await client.query(
      "UPDATE airtime_orders SET status='PAID', mpesa_receipt_number=$2, mpesa_transaction_id=$3, paid_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='PENDING_PAYMENT' RETURNING *",
      [order.id, receipt || null, transactionId || null]
    );
    paidOrder = updated.rows[0] || null;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") return { outcome: "DUPLICATE_PAYMENT" };
    throw error;
  } finally {
    client.release();
  }
  if (paidOrder) await sendAirtime(paidOrder);
  return { outcome: paidOrder ? "PAYMENT_RECORDED" : "ALREADY_PROCESSED" };
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/health", async (req, res) => {
  let databaseReady = false;
  if (pool) {
    try { await pool.query("SELECT 1"); databaseReady = true; } catch (_) {}
  }
  res.status(200).json({
    status: "ok",
    service: "airtime-vending-system",
    databaseConfigured: Boolean(pool),
    databaseReady,
    mpesaCredentialsConfigured: Boolean(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET),
    africasTalkingConfigured: Boolean(AT_USERNAME && AT_API_KEY),
    liveAirtimeEnabled: process.env.LIVE_AIRTIME_ENABLED === "true",
    paymentFlow: "M-Pesa STK Push with verified callback and unique order reference"
  });
});

app.post("/api/orders", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Order database is not connected yet." });
  const network = String(req.body.network || "").toUpperCase();
  const phone = normalizePhone(req.body.phoneNumber);
  const amount = Number(req.body.amount);
  if (!["SAFARICOM", "AIRTEL"].includes(network)) return res.status(400).json({ error: "Choose Safaricom or Airtel." });
  if (!phone) return res.status(400).json({ error: "Enter a valid Kenyan mobile number." });
  if (!Number.isFinite(amount) || amount < 10 || amount > 10000) return res.status(400).json({ error: "Amount must be KES 10 to KES 10,000." });
  const orderReference = ref();
  try {
    const result = await pool.query(
      "INSERT INTO airtime_orders (id,order_reference,network,recipient_phone,amount_kes,payer_phone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING order_reference,network,recipient_phone,amount_kes,status",
      [crypto.randomUUID(), orderReference, network, phone, money(amount), phone]
    );
    res.status(201).json({ order: result.rows[0] });
  } catch (error) {
    console.error("Order creation failed:", error.message);
    res.status(500).json({ error: "Could not create order." });
  }
});

app.post("/api/payments/stk-push", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Order database is not connected yet." });
  const orderReference = String(req.body.orderReference || "").trim().toUpperCase();
  const payerPhone = normalizePhone(req.body.payerPhone);
  if (!orderReference || !payerPhone) return res.status(400).json({ error: "Order reference and valid M-Pesa phone are required." });
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL || "https://airtime-vending-system.onrender.com/payments/stk-callback";
  if (!shortcode || !passkey) return res.status(503).json({ error: "M-Pesa STK Push settings are not complete." });
  try {
    const found = await pool.query("SELECT * FROM airtime_orders WHERE order_reference=$1", [orderReference]);
    if (!found.rowCount || found.rows[0].status !== "PENDING_PAYMENT") return res.status(404).json({ error: "Pending order not found." });
    const order = found.rows[0];
    const token = await mpesaAccessToken();
    const timestamp = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date()).replace(/\D/g, "");
    const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");
    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
      Amount: Math.round(Number(order.amount_kes)),
      PartyA: payerPhone.replace("+", ""),
      PartyB: shortcode,
      PhoneNumber: payerPhone.replace("+", ""),
      CallBackURL: callbackUrl,
      AccountReference: orderReference,
      TransactionDesc: "Airtime " + order.network
    };
    const endpoint = MPESA_BASE_URL + "/mpesa/stkpush/v1/processrequest";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.CheckoutRequestID) {
      console.error("STK Push rejected:", response.status, JSON.stringify(data));
      return res.status(502).json({ error: data.errorMessage || data.ResponseDescription || "M-Pesa did not accept the STK request." });
    }
    await pool.query(
      "UPDATE airtime_orders SET payer_phone=$2, mpesa_checkout_request_id=$3, mpesa_merchant_request_id=$4, updated_at=NOW() WHERE id=$1",
      [order.id, payerPhone, data.CheckoutRequestID, data.MerchantRequestID || null]
    );
    console.log("STK Push accepted by Daraja:", JSON.stringify({ orderReference, checkoutRequestId: data.CheckoutRequestID, merchantRequestId: data.MerchantRequestID || null }));
    res.status(200).json({ message: "STK Push sent. Complete payment on your phone.", orderReference, checkoutRequestId: data.CheckoutRequestID });
  } catch (error) {
    console.error("STK Push error:", error.message);
    res.status(502).json({ error: "Could not start M-Pesa payment. Check configuration and try again." });
  }
});

app.post("/payments/stk-callback", async (req, res) => {
  const incomingCallback = req.body?.Body?.stkCallback;
  console.log("STK callback received:", JSON.stringify({
    checkoutRequestId: incomingCallback?.CheckoutRequestID || null,
    resultCode: incomingCallback?.ResultCode ?? null
  }));
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID) return;
    const found = await pool.query("SELECT * FROM airtime_orders WHERE mpesa_checkout_request_id=$1", [callback.CheckoutRequestID]);
    if (!found.rowCount) {
      console.warn("STK callback has no matching order:", callback.CheckoutRequestID);
      return;
    }
    if (Number(callback.ResultCode) !== 0) {
      await pool.query("UPDATE airtime_orders SET status='FAILED', updated_at=NOW() WHERE id=$1 AND status='PENDING_PAYMENT'", [found.rows[0].id]);
      return;
    }
    const items = callback.CallbackMetadata?.Item || [];
    const get = name => items.find(item => item.Name === name)?.Value;
    const receipt = get("MpesaReceiptNumber");
    const paidAmount = Number(get("Amount"));
    const paidPhone = get("PhoneNumber");
    const outcome = await recordPayment({
      orderReference: found.rows[0].order_reference,
      receipt,
      amount: paidAmount,
      transactionId: callback.CheckoutRequestID,
      payerPhone: String(paidPhone || ""),
      payload: req.body
    });
    console.log("STK payment callback processed:", outcome.outcome);
  } catch (error) {
    console.error("STK callback processing error:", error.message);
  }
});

app.post("/payments/confirmation", async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    const body = req.body || {};
    if (!body.BillRefNumber || !body.TransID || !body.TransAmount) {
      console.warn("C2B payment has no usable order reference; no airtime sent.");
      return;
    }
    const outcome = await recordPayment({
      orderReference: String(body.BillRefNumber).trim().toUpperCase(),
      receipt: String(body.TransID),
      amount: Number(body.TransAmount),
      transactionId: String(body.TransID),
      payload: body
    });
    console.log("C2B payment callback processed:", outcome.outcome);
  } catch (error) {
    console.error("C2B confirmation processing error:", error.message);
  }
});

app.post("/payments/validation", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.post("/airtime/callback", async (req, res) => {
  res.status(200).send("Received");
  try {
    if (!pool) return;
    const body = req.body || {};
    const fp = fingerprint(body);
    await pool.query(
      "INSERT INTO airtime_callbacks (callback_fingerprint,provider_request_id,provider_status,raw_payload) VALUES ($1,$2,$3,$4) ON CONFLICT (callback_fingerprint) DO NOTHING",
      [fp, body.requestId || null, body.status || null, JSON.stringify(body)]
    );
    if (!body.requestId) return;
    const delivered = String(body.status || "").toLowerCase() === "success";
    const failed = String(body.status || "").toLowerCase() === "failed";
    if (!delivered && !failed) return;
    const status = delivered ? "DELIVERED" : "FAILED";
    const result = await pool.query(
      "UPDATE airtime_orders SET status=$2, airtime_provider_status=$3, delivered_at=CASE WHEN $2='DELIVERED' THEN NOW() ELSE delivered_at END, updated_at=NOW() WHERE airtime_provider_request_id=$1 RETURNING id",
      [body.requestId, status, body.status]
    );
    if (result.rowCount) {
      await pool.query("UPDATE airtime_delivery_attempts SET status=$2, updated_at=NOW() WHERE provider_request_id=$1",
        [body.requestId, delivered ? "DELIVERED" : "FAILED"]);
    }
  } catch (error) {
    console.error("Airtime callback processing error:", error.message);
  }
});

app.post("/callback", (req, res) => res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" }));

async function start() {
  try {
    if (pool) await initializeDatabase();
    else console.warn("DATABASE_URL is missing; order and payment features are disabled.");
    app.listen(PORT, () => console.log("Server running on port " + PORT));
  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exit(1);
  }
}
start();
