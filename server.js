const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Airtime Vending System is running!");
});

// Safaricom payment notification
app.post("/payments/confirmation", (req, res) => {
    console.log("Payment received:", req.body);

    res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

// Safaricom validation
app.post("/payments/validation", (req, res) => {
    res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

const PORT = process.env.PORT || 3000;

// Safaricom callback
app.post('/callback', (req, res) => {
    console.log('Safaricom callback received:', JSON.stringify(req.body));

    res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

// Africa's Talking Airtime transaction status notifications
app.post('/airtime/callback', (req, res) => {
    console.log("Africa's Talking Airtime notification:", JSON.stringify(req.body));
    res.status(200).send("Received");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
