require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { SUPABASE_URL, SUPABASE_KEY } = require("./config");

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
    supabase_url: !!SUPABASE_URL,
    supabase_key: !!SUPABASE_KEY,
    resend: !!process.env.RESEND_API_KEY,
    lemonsqueezy: !!process.env.LS_WEBHOOK_SECRET,
  },
}));

// TEMP diagnostic: reports the ROLE claim of each candidate Supabase key so we
// can identify which env var actually holds the service_role key (which bypasses
// RLS). Exposes only role/ref/type — never key values/signatures. Remove after.
app.get("/health/keys", (req, res) => {
  const names = [
    "SUPABASE_agent7d_anon",
    "SUPABASE_agent7d_API_Key",
    "SUPABASE_agent7d_secret_keys",
    "SUPABASE_agent7d_service_role",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const out = {};
  for (const n of names) {
    const v = process.env[n];
    if (!v) { out[n] = null; continue; }
    if (v.startsWith("sb_")) { out[n] = { type: v.split("_").slice(0, 2).join("_") + "_…" }; continue; }
    const parts = v.split(".");
    if (parts.length === 3) {
      try {
        const p = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
        out[n] = { type: "jwt", role: p.role, ref: p.ref };
      } catch { out[n] = { type: "jwt", role: "decode-error" }; }
    } else {
      out[n] = { type: "opaque", len: v.length };
    }
  }
  res.json(out);
});

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
