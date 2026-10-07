const express = require('express');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to format phone number to 2547XXXXXXXX or 2541XXXXXXXX
function formatPhoneNumber(phone) {
    let formatted = phone.trim().replace(/\+/g, '');
    if (formatted.startsWith('0')) {
        formatted = '254' + formatted.slice(1);
    } else if (formatted.startsWith('7') || formatted.startsWith('1')) {
        formatted = '254' + formatted;
    }
    return formatted;
}

// 1. Generate OAuth Access Token
async function getAccessToken() {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    
    if (!consumerKey || !consumerSecret || consumerKey.includes('YOUR_')) {
        throw new Error("Missing or invalid MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in .env file");
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

    const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}` }
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to generate token: ${errText}`);
    }

    const data = await response.json();
    return data.access_token;
}

// 2. Initiate STK Push Endpoint
app.post('/api/stkpush', async (req, res) => {
    try {
        const { phone, amount } = req.body;
        
        if (!phone || !amount) {
            return res.status(400).json({ error: "Phone number and amount are required" });
        }

        const formattedPhone = formatPhoneNumber(phone);
        const accessToken = await getAccessToken();
        const url = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
        
        const shortcode = process.env.MPESA_SHORTCODE || "174379";
        const passkey = process.env.MPESA_PASSKEY;
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        const requestBody = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: amount.toString(),
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: process.env.CALLBACK_URL,
            AccountReference: "BoilerplateOrder",
            TransactionDesc: "Payment for goods/services"
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();
        
        if (data.ResponseCode === "0") {
            return res.json({ success: true, message: "STK Push initiated successfully!", data });
        } else {
            return res.status(400).json({ success: false, message: data.CustomerMessage || "Failed to trigger checkout prompt", data });
        }

    } catch (error) {
        console.error("STK Push Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// 3. Callback URL Endpoint (Safaricom Webhook webhook destination)
app.post('/api/callback', (req, res) => {
    console.log("======== MPESA CALLBACK RECEIVED ========");
    const callbackData = req.body.Body.stkCallback;
    console.log("Full Callback Payload:", JSON.stringify(req.body, null, 2));

    const resultCode = callbackData.ResultCode;
    const resultDesc = callbackData.ResultDesc;
    const merchantRequestID = callbackData.MerchantRequestID;
    const checkoutRequestID = callbackData.CheckoutRequestID;

    if (resultCode === 0) {
        console.log(`[SUCCESS] Payment for CheckoutRequestID: ${checkoutRequestID} was successful.`);
        // Extract payment items (Amount, Receipt Number, Date, Phone)
        const items = callbackData.CallbackMetadata.Item;
        const meta = {};
        items.forEach(item => {
            meta[item.Name] = item.Value;
        });
        console.log("Transaction Metadata Extracted:", meta);
        // TODO: Update transaction entry as paid in database
    } else {
        console.log(`[FAILED/CANCELLED] CheckoutRequestID: ${checkoutRequestID}. Reason: ${resultDesc} (Code ${resultCode})`);
        // TODO: Update transaction entry as cancelled/failed in database
    }

    // Always respond with a standard success status to acknowledge Safaricom's webhook request
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted successfully" });
});

app.listen(PORT, () => {
    console.log(`Server executing live on http://localhost:${PORT}`);
});
