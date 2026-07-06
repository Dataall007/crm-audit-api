require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: [process.env.FRONTEND_URL || "*"] }));
app.use(express.json({ limit: "2mb" }));

// Raw body for LemonSqueezy webhook signature verification
app.use("/api/payment/webhook", express.raw({ type: "application/json" }));

app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

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
