const express = require("express");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const AT_USERNAME = process.env.AT_USERNAME;
const AT_API_KEY = process.env.AT_API_KEY;
const AIRTIME_INTERNAL_TOKEN = process.env.AIRTIME_INTERNAL_TOKEN;
const AT_BASE_URL = process.env.AT_BASE_URL || "https://api.africastalking.com";

app.get("/", (req, res) => {
    res.send("Airtime Vending System is running!");
});

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        service: "airtime-vending-system",
        integrations: {
            africasTalkingConfigured: Boolean(AT_USERNAME && AT_API_KEY),
            internalAirtimeProtectionConfigured: Boolean(AIRTIME_INTERNAL_TOKEN)
        },
        callbacks: {
            mpesaConfirmation: "/payments/confirmation",
            mpesaValidation: "/payments/validation",
            airtimeStatus: "/airtime/callback"
        },
        liveAirtimeEnabled: false,
        note: "Airtime sending remains protected and must only be connected to verified payment orders."
    });
});

// M-Pesa confirmation notification. This endpoint acknowledges the callback only.
// It deliberately does not send airtime until payment-to-order matching and durable
// transaction storage have been configured and tested.
app.post("/payments/confirmation", (req, res) => {
    console.log("M-Pesa payment confirmation received:", JSON.stringify(req.body));
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.post("/payments/validation", (req, res) => {
    console.log("M-Pesa validation received:", JSON.stringify(req.body));
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// Protected Africa's Talking airtime sender for controlled integration tests.
// It is NOT called automatically by M-Pesa until verified order matching is implemented.
app.post("/airtime/send", async (req, res) => {
    if (!AIRTIME_INTERNAL_TOKEN || req.get("x-internal-token") !== AIRTIME_INTERNAL_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (!AT_USERNAME || !AT_API_KEY) {
        return res.status(503).json({ error: "Africa's Talking credentials are not configured." });
    }

    const phoneNumber = String(req.body.phoneNumber || "").trim();
    const amount = Number(req.body.amount);

    if (!/^\+254[17]\d{8}$/.test(phoneNumber)) {
        return res.status(400).json({ error: "Use a Kenyan mobile number in +254XXXXXXXXX format." });
    }
    if (!Number.isFinite(amount) || amount < 10 || amount > 10000) {
        return res.status(400).json({ error: "Amount must be between KES 10 and KES 10,000." });
    }

    try {
        const form = new URLSearchParams();
        form.set("username", AT_USERNAME);
        form.set("recipients", JSON.stringify([{
            phoneNumber,
            amount: "KES " + amount.toFixed(2)
        }]));
        form.set("maxNumRetry", "0");

        const response = await fetch(AT_BASE_URL + "/version1/airtime/send", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
                "apiKey": AT_API_KEY
            },
            body: form.toString()
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error("Africa's Talking API error:", response.status, JSON.stringify(result));
            return res.status(502).json({ error: "Airtime provider rejected the request.", providerStatus: response.status });
        }

        console.log("Africa's Talking airtime API response:", JSON.stringify(result));
        return res.status(200).json(result);
    } catch (error) {
        console.error("Airtime API request failed:", error.message);
        return res.status(502).json({ error: "Could not reach the airtime provider." });
    }
});

// Africa's Talking delivery status callback.
app.post("/airtime/callback", (req, res) => {
    console.log("Africa's Talking airtime delivery status:", JSON.stringify(req.body));
    res.status(200).send("Received");
});

// Retain the old callback path for any existing dashboard configuration.
app.post("/callback", (req, res) => {
    console.log("Legacy callback received:", JSON.stringify(req.body));
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
