const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Fetch full audit (for paid users)
router.get("/:auditId", async (req, res, next) => {
  try {
    const row = await getFromSupabase(req.params.auditId);
    if (!row) return res.status(404).json({ error: "Audit not found" });
    res.json({ paid: row.paid, score: row.score, auditId: row.audit_id, companyName: row.company_name });
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
      max_tokens: 4096,
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
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
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
  if (!r.ok) console.error("[supabase] insert error:", await r.text());
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
