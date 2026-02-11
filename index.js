require("dotenv").config();
const express = require("express");
const jwt = require("jsonwebtoken");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Environment variables
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const apiKey = process.env.API_KEY;
const port = process.env.PORT || 3000;

// Lock persistence
const LOCK_FILE = path.join(__dirname, "locks.json");
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes
let locks = {};
try {
  if (fs.existsSync(LOCK_FILE)) {
    const raw = fs.readFileSync(LOCK_FILE, "utf8") || "{}";
    locks = JSON.parse(raw);
  }
} catch (err) {
  console.error("Failed to load locks file", err);
}

function persistLocks() {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(locks));
  } catch (err) {
    console.error("Failed to write locks file", err);
  }
}

function isLocked(phone) {
  const ts = locks[phone];
  if (!ts) return false;
  return Date.now() - ts < LOCK_TTL_MS;
}

function setLock(phone) {
  locks[phone] = Date.now();
  persistLocks();
}

const client = twilio(accountSid, authToken);

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Auth middleware
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers["x-api-key"];

  // Check API key
  if (apiKeyHeader && apiKeyHeader === apiKey) {
    return next();
  }

  // Check Bearer JWT token
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      jwt.verify(token, apiKey);
      return next();
    } catch (error) {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  return res.status(401).json({ error: "Unauthorized" });
};

// POST endpoint to send messages
app.post("/", authMiddleware, async (req, res) => {
  try {
    const { phone, message } = req.body;

    // Validate input
    if (!phone || !Array.isArray(phone) || phone.length === 0) {
      return res.status(400).json({ error: "phone must be a non-empty array" });
    }
    if (phone.length > 5) {
      return res.status(400).json({ error: "Maximum 5 phone numbers allowed" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message must be a text string" });
    }

    // Send messages to all phone numbers in parallel (skip if locked)
    const results = await Promise.all(
      phone.map(async (phoneNumber) => {
        if (isLocked(phoneNumber)) {
          return { phoneNumber, skipped: true, reason: "called recently" };
        }

        const call = await client.calls.create({
          from: fromNumber,
          to: phoneNumber,
          twiml: `<Response><Say>${message}</Say></Response>`,
        });

        // Set lock after successfully creating the call
        try {
          setLock(phoneNumber);
        } catch (err) {
          console.error("Failed to set lock for", phoneNumber, err);
        }

        return { phoneNumber, callSid: call.sid };
      }),
    );

    res.json({ success: true, calls: results });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
