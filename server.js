const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Airtime Vending System is running!");
});

// Safaricom payment notification
app.post("/mpesa/confirmation", (req, res) => {
    console.log("Payment received:", req.body);

    res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

// Safaricom validation
app.post("/mpesa/validation", (req, res) => {
    res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
