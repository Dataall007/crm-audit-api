const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { SUPABASE_URL, SUPABASE_KEY } = require("../config");

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

// @sparticuz/chromium unpacks its Chromium binary to /tmp on first use. If two
// requests (or a request during boot) trigger that concurrently, exec'ing the
// still-being-written file fails with "spawn ETXTBSY". Kick the extraction off
// once at boot and memoize the promise so every caller awaits the SAME unpack.
const chromiumReady = chromium
  .executablePath()
  .then((p) => { console.log("[pdf] chromium ready:", p); return p; })
  .catch((e) => { console.warn("[pdf] chromium pre-extract failed:", e.message); return null; });

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
    // HTTP headers must be ASCII — strip non-ASCII from company name (e.g. Hebrew)
    // or setHeader throws "Invalid character in header content".
    const safeCompany = (row.company_name || "report").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="crm-audit-${safeCompany}-${auditId}.pdf"`);
    res.send(pdf);
  } catch (err) { next(err); }
});

const PDF_OPTIONS = {
  format: "A4",
  printBackground: true,
  margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
};

// One browser for the process, not one per request — same reasoning as
// chromiumReady above, one level up. Launching cost ~400ms and closing another
// 270-870ms on every single PDF, paid again for each report.
let browserPromise = null;

function launchBrowser() {
  return (async () => {
    const execPath = (await chromiumReady) || (await chromium.executablePath());
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: chromium.headless,
    });
    console.log("[pdf] browser launched");
    return browser;
  })();
}

async function getBrowser() {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = browserPromise || (browserPromise = launchBrowser());
    try {
      const browser = await current;
      if (browser.isConnected()) return browser;
      lastErr = new Error("browser disconnected");
    } catch (err) {
      lastErr = err;
    }
    // Swap in a replacement, but only if nobody beat us to it: two requests can
    // observe the same dead browser, and the second must not discard the first's
    // fresh launch (which would leak a Chromium process).
    if (browserPromise === current) browserPromise = launchBrowser();
  }
  throw lastErr || new Error("could not obtain a browser");
}

// Warm at boot so the first report of the day doesn't pay for the launch. The
// catch only marks the rejection handled — browserPromise still rejects, and
// getBrowser() relaunches on the next request.
browserPromise = launchBrowser();
browserPromise.catch(e => console.warn("[pdf] initial browser launch failed:", e.message));

async function generatePdf(html) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      // puppeteer-core returns a Uint8Array; wrap in Buffer so Express res.send()
      // streams it as binary instead of JSON-serializing it.
      return Buffer.from(await page.pdf(PDF_OPTIONS));
    } catch (err) {
      lastErr = err;
      const transient = /ETXTBSY|Failed to launch|Target closed|Session closed|Connection closed|detached|Protocol error/i.test(String(err.message));
      if (!transient || attempt === 3) throw err;
      // The shared browser may have died mid-request — drop it so the next
      // attempt gets a fresh one instead of retrying against a dead process.
      if (browserPromise) browserPromise = null;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    } finally {
      // Close the page, never the browser.
      if (page) await page.close().catch(() => {});
    }
  }
  throw lastErr;
}

// data_citation embeds the client's own column name, which comes straight from
// their Monday board — a column called `<b>Value` must not reshape the report.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Hebrew reaches the report inside Claude's English prose — it quotes board, stage
// and deal names from the prompt. An RTL run sitting in an LTR sentence with no
// direction marks renders reordered: `'לידים 'Leads)` instead of `(Leads / לידים)`.
//
// Each Hebrew run is wrapped in an isolate (U+2068 FSI … U+2069 PDI) rather than the
// RLM/LRM pair: marks only nudge the boundary, while an isolate makes the run a
// self-contained unit so neighbouring punctuation can't be dragged into it. These are
// invisible control characters, so no HTML escaping concerns and report.html can use
// the same strings unchanged.
const HEBREW_RUN_RE = /[֐-׿]+(?:[\s"'׳״.,\-–—/()]+[֐-׿]+)*/g;

function bidi(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(HEBREW_RUN_RE, run => `⁨${run}⁩`);
}

// Short provenance label under the headline figure. Pre-v2 audits have no
// `confidence` key and simply render without a badge.
const CONFIDENCE_BADGES = {
  high: { text: "High confidence — real deal values", cls: "conf-high" },
  medium: { text: "Medium confidence — self-reported average deal value", cls: "conf-medium" },
  low: { text: "Insufficient data — no deal value column detected", cls: "conf-low" },
};

function buildReportHtml(row, fullAccess) {
  const a = row.audit_json || {};
  const qw = a.quick_wins || [];
  const gaps = a.automation_gaps || [];
  const roadmap = a.roadmap || {};

  // The teaser used to render the real content behind `filter: blur(5px)`. Chromium
  // cannot keep a filtered region as vector text, so it rasterised those sections:
  // the free preview weighed 3,314,022 bytes against 216,710 for the full report, and
  // page.pdf() took 2,593ms instead of 615ms. Measured by stripping only the filter.
  //
  // It also shipped the paid content inside the free download — blur is a visual
  // effect, not redaction, and is reversible in principle. Withholding the content
  // outright is both faster and actually private.
  const locked = (content, teaser) => fullAccess
    ? content
    : `<div style="border:1.5px dashed #d1d5db;border-radius:12px;background:#f9fafb;padding:48px 32px;text-align:center;page-break-inside:avoid">
         <div style="font-size:32px;margin-bottom:10px">🔒</div>
         ${teaser ? `<div style="font-size:14px;font-weight:700;color:#374151;margin-bottom:6px">${teaser}</div>` : ""}
         <div style="font-size:15px;font-weight:800;color:#0a0a0a;margin-bottom:4px">Unlock Full Report — $99</div>
         <div style="font-size:12px;color:#6b7280">agent7d.com/tools/crm-audit</div>
       </div>`;

  const gradeColor = (g) => ({ A: "#10b981", B: "#3b82f6", C: "#f59e0b", D: "#ef4444", F: "#dc2626" }[g] || "#6b7280");
  const effortColor = (e) => ({ Low: "#10b981", Medium: "#f59e0b", High: "#ef4444" }[e] || "#6b7280");

  // `full` renders every detail the quick win actually carries; the teaser form is
  // title + impact only. Previously the teaser form was used for everything past the
  // third win even for paying customers, so a $299 report detailed 3 of 12 items.
  // Fields are emitted only when present — the flat schema ships title/impact_usd/
  // effort/steps, but a richer object renders in full without another change here.
  const renderQuickWin = (w, n, full) => `
    <div class="qw-item">
      <div class="qw-num">${n}</div>
      <div style="flex:1">
        <div style="font-weight:700;margin-bottom:4px">${bidi(w.title)}</div>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
          <span class="qw-impact">+$${(w.impact_usd || 0).toLocaleString()}/yr</span>
          ${full && w.effort ? `<span class="effort-badge" style="background:${effortColor(w.effort)}22;color:${effortColor(w.effort)}">${w.effort} Effort</span>` : ""}
          ${full && w.timeline ? `<span class="effort-badge" style="background:#f3f4f6;color:#4b5563">${bidi(w.timeline)}</span>` : ""}
          ${full && w.owner ? `<span class="effort-badge" style="background:#f3f4f6;color:#4b5563">Owner: ${bidi(w.owner)}</span>` : ""}
        </div>
        ${full && w.problem ? `<div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>Problem:</strong> ${bidi(w.problem)}</div>` : ""}
        ${full && w.solution ? `<div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>Solution:</strong> ${bidi(w.solution)}</div>` : ""}
        ${full && (w.steps || []).length ? `<ul style="padding-left:16px;font-size:12px;color:#6b7280">
          ${w.steps.map(s => `<li>${bidi(s)}</li>`).join("")}
        </ul>` : ""}
      </div>
    </div>`;

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
  .leakage-label { font-size: 13px; color: #9f1239; margin-top: 6px; line-height: 1.5; }
  .conf-badge { display: inline-block; margin-top: 10px; padding: 3px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: 0.03em; }
  .conf-high { background: #dcfce7; color: #166534; }
  .conf-medium { background: #fef3c7; color: #92400e; }
  .conf-low { background: #f3f4f6; color: #4b5563; }
  .issue-list { list-style: none; }
  .issue-list li { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
  .issue-list li::before { content: "✗"; color: #e11d48; font-weight: 700; flex-shrink: 0; }
  .grade-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 24px 0; }
  .grade-card { background: #f9fafb; border-radius: 10px; padding: 16px 20px; }
  .grade-val { font-size: 36px; font-weight: 800; }
  .grade-label { font-size: 11px; color: #6b7280; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
  /* A full report can carry 12 detailed wins, so the list now spills past one page.
     Keep an individual win from being split across the break. */
  .qw-item { padding: 14px 0; border-bottom: 1px solid #f3f4f6; display: flex; gap: 12px; page-break-inside: avoid; break-inside: avoid; }
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
      <div>${bidi(row.company_name || "Company")}</div>
      <div>Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</div>
      <div>Report ID: ${row.audit_id}</div>
    </div>
  </div>

  <h1 style="margin-bottom:6px">CRM Health Report</h1>
  <div style="font-size:15px;color:#6b7280;margin-bottom:32px">${bidi(row.company_name || "Company")} · Monday.com Audit</div>

  <div style="display:flex;gap:24px;align-items:flex-start;margin-bottom:32px">
    <div class="score-box">
      <div class="score-num">${a.score || 0}</div>
      <div class="score-label">Health Score</div>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px">/100</div>
    </div>
    <div class="leakage-box" style="flex:1">
      <div style="font-size:11px;color:#9f1239;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">💰 Revenue at Risk</div>
      <div class="leakage-amount">$${(a.revenue_leakage || 0).toLocaleString()}</div>
      <div class="leakage-label">${
        // v2 states exactly where the number came from. Pre-v2 audits fall back to
        // the original generic line rather than showing nothing.
        a.data_citation
          ? bidi(esc(a.data_citation))
          : "Based on pipeline analysis, data quality gaps, and process inefficiencies"
      }</div>
      ${
        CONFIDENCE_BADGES[a.confidence]
          ? `<div class="conf-badge ${CONFIDENCE_BADGES[a.confidence].cls}">${CONFIDENCE_BADGES[a.confidence].text}</div>`
          : ""
      }
    </div>
  </div>

  <div class="section">
    <h2>Critical Findings</h2>
    <ul class="issue-list">
      ${(a.critical_issues || []).map(i => `<li>${bidi(i)}</li>`).join("")}
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

  <div class="narrative">${bidi(a.narrative || "").replace(/\n/g, "<br>")}</div>
</div>

<!-- PAGE 2: Quick Wins — every one rendered in full for paying customers -->
<div class="page">
  <h2 style="margin-bottom:24px">${qw.length} Quick Wins — Ranked by ROI</h2>
  ${(fullAccess ? qw : qw.slice(0, 3)).map((w, i) => renderQuickWin(w, i + 1, true)).join("")}

  ${fullAccess ? "" : locked("", `${Math.max(qw.length - 3, 0)} more quick wins, ranked by ROI`)}
</div>

<!-- PAGE 3: Automation Gaps + Roadmap (locked if not paid) -->
<div class="page">
  ${locked(`
    <div class="section">
      <h2>Automation Gaps Analysis</h2>
      ${gaps.map(g => `
        <div style="padding:12px 0;border-bottom:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center">
          <div style="flex:1">${bidi(g.description)}</div>
          <div style="color:#e11d48;font-weight:700;white-space:nowrap;margin-left:16px">${g.time_saved_hours_month}h/mo saved</div>
        </div>`).join("")}
    </div>

    <div class="section">
      <h2>90-Day Implementation Roadmap</h2>
      <div class="roadmap-grid">
        <div class="roadmap-col">
          <h3>Month 1: Foundation</h3>
          <ul>${(roadmap.month1 || []).map(i => `<li>${bidi(i)}</li>`).join("")}</ul>
        </div>
        <div class="roadmap-col">
          <h3>Month 2: Automation</h3>
          <ul>${(roadmap.month2 || []).map(i => `<li>${bidi(i)}</li>`).join("")}</ul>
        </div>
        <div class="roadmap-col">
          <h3>Month 3: Optimization</h3>
          <ul>${(roadmap.month3 || []).map(i => `<li>${bidi(i)}</li>`).join("")}</ul>
        </div>
      </div>
    </div>
  `, `${gaps.length} automation gaps and your 90-day implementation roadmap`)}
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
// Exported so the report can be rendered and eyeballed without a Chromium run.
module.exports.buildReportHtml = buildReportHtml;
module.exports.generatePdf = generatePdf;
// Test hook: kills the shared browser so crash recovery can be exercised.
module.exports.__killBrowserForTest = async () => {
  const b = await browserPromise;
  await b.close();
};
