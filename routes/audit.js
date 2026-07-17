const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const { SUPABASE_URL, SUPABASE_KEY } = require("../config");

router.post("/", async (req, res, next) => {
  try {
    const { crmSummary, companyName, email, industry, teamSize, monthlyLeads, avgDeal, challenges } = req.body;
    if (!crmSummary || !companyName) return res.status(400).json({ error: "crmSummary and companyName required" });

    const auditJson = await runClaudeAudit({ crmSummary, companyName, industry, teamSize, monthlyLeads, avgDeal, challenges });
    const auditId = uuidv4().slice(0, 8);

    await saveToSupabase({
      audit_id: auditId,
      crm_type: "monday",
      company_name: companyName,
      email: email || null,
      audit_json: auditJson,
      score: auditJson.score,
      revenue_leakage: auditJson.revenue_leakage,
    });

    res.json({
      auditId,
      score: auditJson.score,
      revenue_leakage: auditJson.revenue_leakage,
      critical_issues: auditJson.critical_issues,
      data_quality_grade: auditJson.data_quality_grade,
      pipeline_health_grade: auditJson.pipeline_health_grade,
      quick_wins_preview: auditJson.quick_wins?.slice(0, 3).map(w => ({ title: w.title, impact_usd: w.impact_usd })) || [],
      narrative: auditJson.narrative,
    });
  } catch (err) {
    next(err);
  }
});

// Fetch an audit for report.html. Returns the full preview (free tier);
// paid users additionally get the complete audit payload under `audit_full`.
router.get("/:auditId", async (req, res, next) => {
  try {
    const row = await getFromSupabase(req.params.auditId);
    if (!row) return res.status(404).json({ error: "Audit not found" });

    const a = row.audit_json || {};
    const payload = {
      auditId: row.audit_id,
      companyName: row.company_name,
      paid: !!row.paid,
      score: a.score ?? row.score,
      revenue_leakage: a.revenue_leakage ?? row.revenue_leakage,
      critical_issues: a.critical_issues || [],
      data_quality_grade: a.data_quality_grade || null,
      pipeline_health_grade: a.pipeline_health_grade || null,
      quick_wins_preview: (a.quick_wins || [])
        .slice(0, 3)
        .map(w => ({ title: w.title, impact_usd: w.impact_usd })),
      narrative: a.narrative || "",
    };

    // Paid users get everything (all quick wins, automation gaps, roadmap) plus
    // a token so report.html can link to the full PDF (same token /pdf/full expects).
    if (row.paid) {
      payload.audit_full = a;
      payload.pdf_token = crypto
        .createHmac("sha256", process.env.LS_WEBHOOK_SECRET || "secret")
        .update(row.audit_id)
        .digest("hex")
        .slice(0, 16);
    }

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

async function runClaudeAudit({ crmSummary, companyName, industry, teamSize, monthlyLeads, avgDeal, challenges }) {
  const systemPrompt = `You are a senior CRM consultant with 20 years experience. Return ONLY valid JSON — no markdown, no code fences, no explanation.`;

  const userPrompt = `Analyze this Monday.com CRM data and generate a detailed audit.

Company: ${companyName}
Industry: ${industry || "Not specified"}
Team size: ${teamSize || "Not specified"}
Monthly leads: ${monthlyLeads || "Not specified"}
Average deal value: ${avgDeal || "Not specified"}
Main challenges: ${(challenges || []).join(", ") || "Not specified"}

CRM Data:
${JSON.stringify(crmSummary, null, 2)}

Return JSON with exactly these keys:
{
  "score": <integer 0-100>,
  "revenue_leakage": <annual USD integer>,
  "critical_issues": [<3 specific strings>],
  "data_quality_grade": "<A|B|C|D|F>",
  "pipeline_health_grade": "<A|B|C|D|F>",
  "quick_wins": [
    {"title": "...", "impact_usd": <integer>, "effort": "<Low|Medium|High>", "steps": ["...", "..."]}
  ],
  "automation_gaps": [
    {"description": "...", "time_saved_hours_month": <integer>}
  ],
  "roadmap": {
    "month1": ["..."],
    "month2": ["..."],
    "month3": ["..."]
  },
  "narrative": "Two paragraphs. Executive summary tone. Mention the revenue leakage number. Sound like McKinsey."
}

Be specific with numbers. Base revenue_leakage on: stale items × average deal × estimated loss rate. Minimum 10 quick_wins, minimum 5 automation_gaps.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      // 4096 truncated mid-JSON (10 quick wins + 5 gaps + roadmap + narrative
      // routinely exceed it), producing invalid JSON and a 500. 8192 is safe.
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err?.error?.message || "Claude API error");
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "{}";

  try {
    return JSON.parse(text);
  } catch {
    // Strip any accidental markdown fences
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(clean);
  }
}

async function saveToSupabase(row) {
  // The whole flow depends on persistence: report.html reads the audit back by
  // id. If we can't save, fail loudly rather than returning a 200 with an
  // auditId that GET /:id will 404 on.
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)");
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_audits`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const body = await r.text();
    console.error("[supabase] insert error:", body);
    throw new Error(`Supabase insert failed (${r.status}): ${body}`);
  }
}

async function getFromSupabase(auditId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_audits?audit_id=eq.${auditId}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = await r.json();
  return rows?.[0] || null;
}

module.exports = router;
