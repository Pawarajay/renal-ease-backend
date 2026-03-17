const express = require("express");
const cors    = require("cors");
require("dotenv").config();

const { testConnection }      = require("./config/database");
const { initializeScheduler } = require("./services/scheduler");

// ── Core routes ───────────────────────────────────────────────────────────────
const authRoutes           = require("./routes/auth");
const usersRouter          = require("./routes/users");
const customerRoutes       = require("./routes/customers");
const leadRoutes           = require("./routes/leads");
const invoiceRoutes        = require("./routes/invoices");
const renewalRoutes        = require("./routes/renewals");
const whatsappRoutes       = require("./routes/whatsapp");
const whatsappWebhookRouter= require("./routes/whatsapp-webhook");
const reportRoutes         = require("./routes/reports");
const publicLeadsRouter    = require("./routes/public-leads");

// ── App setup ─────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 5000;

const FRONTEND_URL = (
  // process.env.FRONTEND_URL || "https://crm.renalease.com"
  process.env.FRONTEND_URL 
).replace(/\/$/, "");

const allowedOrigins = [
  FRONTEND_URL,
  "http://localhost:3000",
  "https://renal-ease-frontend.vercel.app"
];

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server / Postman requests (no origin header)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn(`⚠️  CORS blocked: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} — ${req.method} ${req.path}`);
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  try {
    await testConnection();
    res.json({
      status:    "OK",
      message:   "Renalease CRM API is running",
      timestamp: new Date().toISOString(),
      db:        "connected",
      version:   "2.0.0",
    });
  } catch (err) {
    res.status(503).json({
      status:    "DEGRADED",
      message:   "API running but DB unavailable",
      timestamp: new Date().toISOString(),
      db:        "disconnected",
      error:     err.message,
    });
  }
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    message: "Welcome to Renalease CRM API",
    version: "2.0.0",
    endpoints: { health: "/api/health" },
  });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api/auth",      authRoutes);
app.use("/api/users",     usersRouter);
app.use("/api/customers", customerRoutes);
app.use("/api/leads",     leadRoutes);
app.use("/api/invoices",  invoiceRoutes);
app.use("/api/renewals",  renewalRoutes);
app.use("/api/reports",   reportRoutes);
app.use("/api/whatsapp",  whatsappRoutes);
app.use("/api/whatsapp",  whatsappWebhookRouter);
app.use("/api/public",    publicLeadsRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("ERROR:", err.stack);

  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "CORS Error", message: "Origin not allowed" });
  }
  if (err.name === "UnauthorizedError") {
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
  if (err.name === "ValidationError") {
    return res.status(400).json({ error: "Validation Error", message: err.message });
  }

  res.status(err.status || 500).json({
    error:   "Internal Server Error",
    message: process.env.NODE_ENV === "development" ? err.message : "Something went wrong",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use("*", (req, res) => {
  res.status(404).json({
    error:  "Route not found",
    path:   req.originalUrl,
    method: req.method,
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGTERM", () => { console.log("🛑 SIGTERM — shutting down"); process.exit(0); });
process.on("SIGINT",  () => { console.log("🛑 SIGINT — shutting down");  process.exit(0); });
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled rejection at:", promise, "reason:", reason);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    console.log("🔍 Testing database connection…");
    await testConnection();
    console.log("✅ Database connected");

    console.log("⏰ Initialising scheduler…");
    await initializeScheduler();
    console.log("✅ Scheduler ready");

    app.listen(PORT, () => {
      console.log("\n================================================");
      console.log("🏥 Renalease CRM Server Started");
      console.log("================================================");
      console.log(`📦 Environment : ${process.env.NODE_ENV || "development"}`);
      console.log(`🌐 Server URL  : http://localhost:${PORT}`);
      console.log(`🖥️  Frontend    : ${FRONTEND_URL}`);
      console.log(`✅ Origins     :`, allowedOrigins);
      console.log("================================================\n");
    });
  } catch (err) {
    console.error("\n================================================");
    console.error("❌ SERVER STARTUP FAILED");
    console.error("================================================");
    console.error(err.message);
    process.exit(1);
  }
};

startServer();