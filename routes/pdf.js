const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// GET /api/pdf/preview/:auditId — partial (blurred after page 3)
router.get("/preview/:auditId", async (req, res, next) => {
  try {
    const row = await supabaseGet(req.params.auditId);
    if (!row) return res.status(404).json({ error: "Audit not found" });

    const html = buildReportHtml(row, false);
    const pdf = await generatePdf(html);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="crm-audit-preview-${row.audit_id}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

// GET /api/pdf/full/:auditId?token=... — full report (token-gated)
router.get("/full/:auditId", async (req, res, next) => {
  try {
    const { auditId } = req.params;
    const { token } = req.query;
    const expected = crypto.createHmac("sha256", process.env.LS_WEBHOOK_SECRET || "secret")
      .update(auditId).digest("hex").slice(0, 16);
    if (token !== expected) return res.status(403).json({ error: "Invalid token" });

    const row = await supabaseGet(auditId);
    if (!row) return res.status(404).json({ error: "Audit not found" });
    if (!row.paid) return res.status(402).json({ error: "Payment required" });

    const html = buildReportHtml(row, true);
    const pdf = await generatePdf(html);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="crm-audit-${row.company_name?.replace(/\s+/g, "-")}-${auditId}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

async function generatePdf(html) {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
  });
  await browser.close();
  return pdf;
}

function buildReportHtml(row, fullAccess) {
  const a = row.audit_json || {};
  const qw = a.quick_wins || [];
  const gaps = a.automation_gaps || [];
  const roadmap = a.roadmap || {};

  const locked = (content) => fullAccess
    ? content
    : `<div style="position:relative;overflow:hidden"><div style="filter:blur(5px);user-select:none">${content}</div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,10,10,0.55)"><div style="text-align:center;color:#fff"><div style="font-size:28px;margin-bottom:8px">🔒</div><div style="font-size:14px;font-weight:700">Unlock Full Report — $299</div><div style="font-size:12px;opacity:0.7;margin-top:4px">agent7d.com/tools/crm-audit</div></div></div></div>`;

  const gradeColor = (g) => ({ A: "#10b981", B: "#3b82f6", C: "#f59e0b", D: "#ef4444", F: "#dc2626" }[g] || "#6b7280");
  const effortColor = (e) => ({ Low: "#10b981", Medium: "#f59e0b", High: "#ef4444" }[e] || "#6b7280");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #fff; color: #111; font-size: 13px; line-height: 1.6; }
  .page { padding: 40px 48px; page-break-after: always; min-height: 297mm; }
  .page:last-child { page-break-after: avoid; }
  h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; }
  h2 { font-size: 18px; font-weight: 700; margin: 0 0 16px; }
  h3 { font-size: 14px; font-weight: 700; margin: 0 0 8px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; padding-bottom: 24px; border-bottom: 2px solid #f3f4f6; }
  .logo { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; }
  .logo span { color: #e11d48; }
  .score-box { background: #0a0a0a; color: #fff; border-radius: 12px; padding: 20px 28px; text-align: center; min-width: 130px; }
  .score-num { font-size: 48px; font-weight: 800; line-height: 1; }
  .score-label { font-size: 11px; color: #9ca3af; margin-top: 4px; letter-spacing: 0.05em; text-transform: uppercase; }
  .leakage-box { background: #fff1f2; border: 1.5px solid #fecdd3; border-radius: 12px; padding: 24px 32px; margin: 24px 0; }
  .leakage-amount { font-size: 42px; font-weight: 800; color: #e11d48; letter-spacing: -0.02em; }
  .leakage-label { font-size: 13px; color: #9f1239; margin-top: 2px; }
  .issue-list { list-style: none; }
  .issue-list li { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
  .issue-list li::before { content: "✗"; color: #e11d48; font-weight: 700; flex-shrink: 0; }
  .grade-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 24px 0; }
  .grade-card { background: #f9fafb; border-radius: 10px; padding: 16px 20px; }
  .grade-val { font-size: 36px; font-weight: 800; }
  .grade-label { font-size: 11px; color: #6b7280; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
  .qw-item { padding: 14px 0; border-bottom: 1px solid #f3f4f6; display: flex; gap: 12px; }
  .qw-num { background: #0a0a0a; color: #fff; width: 24px; height: 24px; border-radius: 50%; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px; }
  .qw-impact { font-weight: 700; color: #e11d48; }
  .effort-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; }
  .roadmap-col { background: #f9fafb; border-radius: 10px; padding: 16px 20px; }
  .roadmap-col h3 { color: #e11d48; }
  .roadmap-col ul { list-style: none; }
  .roadmap-col li { padding: 5px 0; border-bottom: 1px solid #e5e7eb; font-size: 12px; }
  .roadmap-col li:last-child { border: none; }
  .roadmap-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 16px; }
  .footer-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #0a0a0a; color: #9ca3af; font-size: 10px; padding: 8px 48px; display: flex; justify-content: space-between; }
  .section { margin-bottom: 32px; }
  .narrative { font-size: 14px; line-height: 1.8; color: #374151; background: #f9fafb; border-left: 3px solid #e11d48; padding: 20px 24px; border-radius: 0 8px 8px 0; }
</style>
</head>
<body>

<!-- PAGE 1: Executive Summary -->
<div class="page">
  <div class="header">
    <div>
      <div class="logo">agent<span>7</span>d</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px">CRM Intelligence Platform</div>
    </div>
    <div style="text-align:right;font-size:11px;color:#9ca3af">
      <div>${row.company_name || "Company"}</div>
      <div>Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div>
      <div>Report ID: ${row.audit_id}</div>
    </div>
  </div>

  <h1 style="margin-bottom:6px">CRM Health Report</h1>
  <div style="font-size:15px;color:#6b7280;margin-bottom:32px">${row.company_name || "Company"} · Monday.com Audit</div>

  <div style="display:flex;gap:24px;align-items:flex-start;margin-bottom:32px">
    <div class="score-box">
      <div class="score-num">${a.score || 0}</div>
      <div class="score-label">Health Score</div>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px">/100</div>
    </div>
    <div class="leakage-box" style="flex:1">
      <div style="font-size:11px;color:#9f1239;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">💰 Estimated Annual Revenue Leakage</div>
      <div class="leakage-amount">$${(a.revenue_leakage || 0).toLocaleString()}</div>
      <div class="leakage-label">Based on pipeline analysis, data quality gaps, and process inefficiencies</div>
    </div>
  </div>

  <div class="section">
    <h2>Critical Findings</h2>
    <ul class="issue-list">
      ${(a.critical_issues || []).map(i => `<li>${i}</li>`).join("")}
    </ul>
  </div>

  <div class="section">
    <h2>System Health Grades</h2>
    <div class="grade-grid">
      <div class="grade-card">
        <div class="grade-val" style="color:${gradeColor(a.data_quality_grade)}">${a.data_quality_grade || "?"}</div>
        <div class="grade-label">Data Quality</div>
      </div>
      <div class="grade-card">
        <div class="grade-val" style="color:${gradeColor(a.pipeline_health_grade)}">${a.pipeline_health_grade || "?"}</div>
        <div class="grade-label">Pipeline Health</div>
      </div>
    </div>
  </div>

  <div class="narrative">${(a.narrative || "").replace(/\n/g, "<br>")}</div>
</div>

<!-- PAGE 2: Quick Wins (first 3 visible, rest locked) -->
<div class="page">
  <h2 style="margin-bottom:24px">Top 10 Quick Wins — Ranked by ROI</h2>
  ${qw.slice(0, 3).map((w, i) => `
    <div class="qw-item">
      <div class="qw-num">${i + 1}</div>
      <div style="flex:1">
        <div style="font-weight:700;margin-bottom:4px">${w.title}</div>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:6px">
          <span class="qw-impact">+$${(w.impact_usd || 0).toLocaleString()}/yr</span>
          <span class="effort-badge" style="background:${effortColor(w.effort)}22;color:${effortColor(w.effort)}">${w.effort} Effort</span>
        </div>
        <ul style="padding-left:16px;font-size:12px;color:#6b7280">
          ${(w.steps || []).map(s => `<li>${s}</li>`).join("")}
        </ul>
      </div>
    </div>`).join("")}

  ${locked(qw.slice(3).map((w, i) => `
    <div class="qw-item">
      <div class="qw-num">${i + 4}</div>
      <div style="flex:1">
        <div style="font-weight:700;margin-bottom:4px">${w.title}</div>
        <span class="qw-impact">+$${(w.impact_usd || 0).toLocaleString()}/yr</span>
      </div>
    </div>`).join(""))}
</div>

<!-- PAGE 3: Automation Gaps + Roadmap (locked if not paid) -->
<div class="page">
  ${locked(`
    <div class="section">
      <h2>Automation Gaps Analysis</h2>
      ${gaps.map(g => `
        <div style="padding:12px 0;border-bottom:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center">
          <div style="flex:1">${g.description}</div>
          <div style="color:#e11d48;font-weight:700;white-space:nowrap;margin-left:16px">${g.time_saved_hours_month}h/mo saved</div>
        </div>`).join("")}
    </div>

    <div class="section">
      <h2>90-Day Implementation Roadmap</h2>
      <div class="roadmap-grid">
        <div class="roadmap-col">
          <h3>Month 1: Foundation</h3>
          <ul>${(roadmap.month1 || []).map(i => `<li>${i}</li>`).join("")}</ul>
        </div>
        <div class="roadmap-col">
          <h3>Month 2: Automation</h3>
          <ul>${(roadmap.month2 || []).map(i => `<li>${i}</li>`).join("")}</ul>
        </div>
        <div class="roadmap-col">
          <h3>Month 3: Optimization</h3>
          <ul>${(roadmap.month3 || []).map(i => `<li>${i}</li>`).join("")}</ul>
        </div>
      </div>
    </div>
  `)}
</div>

<div class="footer-bar">
  <span>agent7d.com · CRM Intelligence Platform · Confidential</span>
  <span>Report ID: ${row.audit_id} · ${row.company_name || ""}</span>
</div>

</body>
</html>`;
}

async function supabaseGet(auditId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_audits?audit_id=eq.${auditId}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return (await r.json())?.[0] || null;
}

module.exports = router;
