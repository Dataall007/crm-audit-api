const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { Resend } = require("resend");

const { SUPABASE_URL, SUPABASE_KEY } = require("../config");
const FRONTEND_URL = process.env.FRONTEND_URL || "https://agent7d.com";

// LemonSqueezy's /checkout/buy/ path needs the store buy-link UUID, NOT the
// numeric variant/product ID (those 404). Warn loudly at boot if it looks wrong.
const LS_VARIANT_ID = process.env.LS_VARIANT_ID;
if (!LS_VARIANT_ID) {
  console.warn("[payment] ⚠️ LS_VARIANT_ID is missing — checkout will 404.");
} else if (/^\d+$/.test(LS_VARIANT_ID)) {
  console.warn(`[payment] ⚠️ LS_VARIANT_ID="${LS_VARIANT_ID}" is numeric — /checkout/buy/ needs the buy-link UUID (e.g. c8ee4e0e-…) or it will 404.`);
}

function getResend() { return new Resend(process.env.RESEND_API_KEY); }

// LemonSqueezy webhook (raw body for signature)
router.post("/webhook", async (req, res) => {
  try {
    const sig = req.headers["x-signature"];
    const secret = process.env.LS_WEBHOOK_SECRET;
    if (secret && sig) {
      const hmac = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
      if (hmac !== sig) return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(req.body.toString());
    const event = payload.meta?.event_name;
    if (event !== "order_created") return res.json({ ok: true });

    const auditId = payload.data?.attributes?.first_order_item?.meta?.audit_id
      || payload.meta?.custom_data?.audit_id;
    const email = payload.data?.attributes?.user_email;
    const company = payload.meta?.custom_data?.company || "Your Company";

    if (!auditId) return res.json({ ok: true, skipped: "no audit_id" });

    // Mark paid in Supabase
    await supabaseUpdate(auditId, { paid: true });

    // Fetch audit data
    const row = await supabaseGet(auditId);
    if (!row) return res.json({ ok: true, skipped: "audit not found" });

    // Generate full PDF URL (Puppeteer route)
    const pdfUrl = `${process.env.RENDER_BASE_URL}/api/pdf/full/${auditId}?token=${generateToken(auditId)}`;

    // Send delivery email
    await getResend().emails.send({
      from: "support@agent7d.com",
      to: email,
      subject: `Your Complete CRM Audit Report — ${company}`,
      html: buildDeliveryEmail({ company, pdfUrl, auditId }),
    });

    console.log(`[payment] ✅ paid — auditId:${auditId} email:${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("[payment webhook error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create LemonSqueezy checkout URL
router.post("/checkout", async (req, res, next) => {
  try {
    const { auditId, email, company } = req.body;
    if (!auditId) return res.status(400).json({ error: "auditId required" });

    const checkoutUrl = buildLemonSqueezyUrl({ auditId, email, company });
    res.json({ checkoutUrl });
  } catch (err) {
    next(err);
  }
});

function buildLemonSqueezyUrl({ auditId, email, company }) {
  const base = `https://agent7d.lemonsqueezy.com/checkout/buy/${LS_VARIANT_ID}`;
  // Only include params that have values. An empty checkout[email]= makes
  // LemonSqueezy return 422, and the report button posts no email.
  const params = new URLSearchParams();
  params.set("checkout[custom][audit_id]", auditId);
  if (email) params.set("checkout[email]", email);
  if (company) params.set("checkout[custom][company]", company);
  return `${base}?${params.toString()}`;
}

function generateToken(auditId) {
  return crypto.createHmac("sha256", process.env.LS_WEBHOOK_SECRET || "secret")
    .update(auditId).digest("hex").slice(0, 16);
}

async function supabaseUpdate(auditId, updates) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/crm_audits?audit_id=eq.${auditId}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
}

async function supabaseGet(auditId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_audits?audit_id=eq.${auditId}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return (await r.json())?.[0] || null;
}

function buildDeliveryEmail({ company, pdfUrl, auditId }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
  <div style="background:#0a0a0a;padding:28px 32px">
    <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.02em">agent<span style="color:#e11d48">7</span>d</div>
    <div style="font-size:13px;color:#9ca3af;margin-top:4px">CRM Intelligence Platform</div>
  </div>
  <div style="padding:32px">
    <h2 style="font-size:20px;font-weight:700;color:#111;margin:0 0 8px">Your Full CRM Audit Report is Ready</h2>
    <p style="font-size:14px;color:#6b7280;margin:0 0 24px">Company: <strong>${company}</strong></p>
    <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 24px">Your complete 20+ page consulting-grade report is attached. It includes the full revenue leakage analysis, all 10 quick wins with implementation steps, your 90-day roadmap, and automation gap analysis.</p>
    <a href="${pdfUrl}" style="display:inline-block;background:#e11d48;color:#fff;padding:14px 28px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none;margin-bottom:24px">Download Full Report (PDF) →</a>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-top:8px">
      <p style="font-size:14px;font-weight:700;color:#111;margin:0 0 6px">Want help implementing these changes?</p>
      <p style="font-size:13px;color:#6b7280;margin:0 0 12px">Our bClarity consulting team can implement your entire 90-day roadmap in weeks, not months.</p>
      <a href="https://agent7d.com/#services" style="font-size:13px;font-weight:700;color:#e11d48;text-decoration:none">Book a Free 30-min Strategy Call →</a>
    </div>
  </div>
  <div style="background:#f9fafb;padding:16px 32px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6">
    agent7d.com · Report ID: ${auditId} · Confidential
  </div>
</div>
</body></html>`;
}

module.exports = router;
