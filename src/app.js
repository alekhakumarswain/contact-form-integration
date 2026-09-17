const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: true, limit: "20kb" }));

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5000")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin requests and local tools without an Origin header.
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS origin not allowed"));
    }
  })
);

app.use(express.static(path.join(__dirname, "..", "public")));

// Demo storage for the assignment.
// IMPORTANT: This is in-memory, so data resets when the server/serverless instance restarts.
// Replace this with MongoDB/PostgreSQL later if persistent storage is required.
const enquiries = [];
let nextId = 1;

const MIN_NAME = 2;
const MAX_NAME = 80;
const MIN_MESSAGE = 10;
const MAX_MESSAGE = 2000;

function validateContact(body = {}) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  const errors = {};

  if (!name) errors.name = "Name is required.";
  else if (name.length < MIN_NAME) errors.name = `Name must be at least ${MIN_NAME} characters.`;
  else if (name.length > MAX_NAME) errors.name = `Name must be at most ${MAX_NAME} characters.`;

  if (!email) errors.email = "Email is required.";
  else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Please enter a valid email address.";
  }

  if (!message) errors.message = "Message is required.";
  else if (message.length < MIN_MESSAGE) errors.message = `Message must be at least ${MIN_MESSAGE} characters.`;
  else if (message.length > MAX_MESSAGE) errors.message = `Message must be at most ${MAX_MESSAGE} characters.`;

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    value: { name, email, message }
  };
}

async function createTransporter() {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "COMPANY_EMAIL"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing SMTP environment variables: ${missing.join(", ")}`);
  }

  // Helpful validation for common placeholder values
  const host = String(process.env.SMTP_HOST || "").trim();
  if (!host || host.includes("example")) {
    if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
      throw new Error(
        `SMTP_HOST appears to be a placeholder (${host}). Please set a real SMTP host in your .env for production.`
      );
    }

    // Development fallback: create an Ethereal test account automatically.
    // This avoids failing during local testing when the user hasn't configured SMTP yet.
    console.warn(
      `SMTP_HOST looks like a placeholder (${host}). Creating an Ethereal test account for local testing.`
    );

    const testAccount = await nodemailer.createTestAccount();

    return nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
  }

  // Allow local/dev SMTP servers like MailHog without auth
  if (host === "localhost" || host.includes("mailhog")) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 1025,
      secure: false
    });
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendCompanyEmail(enquiry) {
  const transporter = await createTransporter();

  const info = await transporter.sendMail({
    from: `"Website Contact Form" <${process.env.SMTP_USER}>`,
    to: process.env.COMPANY_EMAIL,
    replyTo: enquiry.email,
    subject: `New website enquiry from ${enquiry.name}`,
    text: [
      `New contact enquiry`,
      ``,
      `Name: ${enquiry.name}`,
      `Email: ${enquiry.email}`,
      `Message:`,
      enquiry.message,
      ``,
      `Received: ${enquiry.createdAt}`
    ].join("\n")
  });

  // If using Ethereal, log the preview URL for convenience
  try {
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.info("Preview email:", preview);
  } catch (e) {
    // ignore
  }

  return info;
}

async function sendAutoReply(enquiry) {
  if (String(process.env.SEND_AUTO_REPLY).toLowerCase() !== "true") return;

  const transporter = await createTransporter();

  const info = await transporter.sendMail({
    from: `"Company Contact" <${process.env.SMTP_USER}>`,
    to: enquiry.email,
    subject: "We received your enquiry",
    text: `Hi ${enquiry.name},\n\nThanks for contacting us. We received your message and will get back to you soon.\n\nRegards,\nCompany Team`
  });

  try {
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.info("Preview auto-reply:", preview);
  } catch (e) {
    // ignore
  }
}

// Health endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "API is running"
  });
});

// TASK 1 + TASK 2: POST /api/contact
app.post("/api/contact", async (req, res, next) => {
  try {
    const result = validateContact(req.body);

    if (!result.valid) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: result.errors
      });
    }

    const enquiry = {
      id: nextId++,
      ...result.value,
      status: "new",
      createdAt: new Date().toISOString()
    };

    // Store after validation. SMTP is attempted before returning success.
    await sendCompanyEmail(enquiry);

    enquiries.unshift(enquiry);

    try {
      await sendAutoReply(enquiry);
    } catch (replyError) {
      // Visitor acknowledgement failing should not make the main company notification fail.
      console.error("Auto-reply failed:", replyError.message);
    }

    return res.status(201).json({
      success: true,
      message: "Your enquiry was submitted successfully.",
      data: {
        id: enquiry.id,
        status: enquiry.status
      }
    });
  } catch (error) {
    console.error("Contact API error:", error);
    return res.status(500).json({
      success: false,
      message: "The enquiry could not be submitted right now. Please try again later."
    });
  }
});

// TASK 3: Admin API
function requireAdmin(req, res, next) {
  const configuredToken = process.env.ADMIN_TOKEN;
  const suppliedToken = req.get("x-admin-token");

  if (!configuredToken) {
    return res.status(503).json({
      success: false,
      message: "Admin access is not configured."
    });
  }

  if (!suppliedToken || suppliedToken !== configuredToken) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized."
    });
  }

  next();
}

app.get("/api/enquiries", requireAdmin, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const status = String(req.query.status || "").trim().toLowerCase();

  let results = enquiries;

  if (q) {
    results = results.filter((item) =>
      item.name.toLowerCase().includes(q) ||
      item.email.toLowerCase().includes(q) ||
      item.message.toLowerCase().includes(q)
    );
  }

  if (status && ["new", "read", "resolved"].includes(status)) {
    results = results.filter((item) => item.status === status);
  }

  res.status(200).json({
    success: true,
    data: results
  });
});

app.patch("/api/enquiries/:id/status", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const allowed = ["new", "read", "resolved"];
  const status = String(req.body.status || "").trim().toLowerCase();

  const enquiry = enquiries.find((item) => item.id === id);

  if (!enquiry) {
    return res.status(404).json({
      success: false,
      message: "Enquiry not found."
    });
  }

  if (!allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Status must be one of: ${allowed.join(", ")}.`
    });
  }

  enquiry.status = status;

  res.status(200).json({
    success: true,
    message: "Status updated.",
    data: enquiry
  });
});

app.delete("/api/enquiries/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const index = enquiries.findIndex((item) => item.id === id);

  if (index === -1) {
    return res.status(404).json({
      success: false,
      message: "Enquiry not found."
    });
  }

  const [deleted] = enquiries.splice(index, 1);

  res.status(200).json({
    success: true,
    message: "Enquiry deleted.",
    data: { id: deleted.id }
  });
});

// JSON 404 for unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

// Final error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

module.exports = app;
