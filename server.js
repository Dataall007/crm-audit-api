require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: (origin, cb) => cb(null, true), // allow all origins incl. null (local file)
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));

// Raw body for LemonSqueezy webhook signature verification
app.use("/api/payment/webhook", express.raw({ type: "application/json" }));

app.get("/health", (req, res) => res.json({
  ok: true,
  ts: new Date().toISOString(),
  // Presence-only (booleans, never values) so we can diagnose config remotely.
  env: {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    supabase_url: !!process.env.SUPABASE_URL,
    supabase_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    resend: !!process.env.RESEND_API_KEY,
    lemonsqueezy: !!process.env.LS_WEBHOOK_SECRET,
  },
}));

app.use("/api/crm", require("./routes/crm"));
app.use("/api/audit", require("./routes/audit"));
app.use("/api/pdf", require("./routes/pdf"));
app.use("/api/payment", require("./routes/payment"));

app.use((err, req, res, next) => {
  console.error("[error]", err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () =>
  console.log(`[crm-audit-api] running on :${PORT}`)
);
