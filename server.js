const express = require("express");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
    res.send("Airtime Vending System is running!");
});

// Safaricom M-Pesa payment confirmation
app.post("/payments/confirmation", (req, res) => {
    console.log("Payment received:", JSON.stringify(req.body));
    res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

// Safaricom M-Pesa payment validation
app.post("/payments/validation", (req, res) => {
    console.log("M-Pesa validation received:", JSON.stringify(req.body));
    res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

// Africa's Talking Airtime validation.
// Keep transactions blocked until payment verification and customer-order checks
// are implemented. This prevents unverified airtime requests being approved.
app.post("/validation", (req, res) => {
    console.log("Africa's Talking airtime validation received:", JSON.stringify(req.body));
    res.status(200).json({
        status: "Failed"
    });
});

// Keep the older path working if it was previously configured.
app.post("/airtime/validation", (req, res) => {
    console.log("Africa's Talking airtime validation received:", JSON.stringify(req.body));
    res.status(200).json({
        status: "Failed"
    });
});

// Safaricom callback
app.post("/callback", (req, res) => {
    console.log("Safaricom callback received:", JSON.stringify(req.body));
    res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

// Africa's Talking Airtime delivery-status notifications
app.post("/airtime/callback", (req, res) => {
    console.log("Africa's Talking Airtime notification:", JSON.stringify(req.body));
    res.status(200).send("Received");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
