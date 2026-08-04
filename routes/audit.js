const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const { SUPABASE_URL, SUPABASE_KEY } = require("../config");
// Single source of truth for the loss rate / stale window, so the number in the
// report and the number in the citation can never drift apart.
const { STALL_LOSS_RATE, STALE_DAYS } = require("./crm");

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
      data_citation: auditJson.data_citation,
      confidence: auditJson.confidence,
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
      // v2 provenance. Null on pre-v2 audits — report.html ignores unknown keys,
      // so old reports keep rendering exactly as before.
      data_citation: a.data_citation || null,
      confidence: a.confidence || null,
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

// --- v2: code computes, Claude explains -------------------------------------

const LOSS_PCT = Math.round(STALL_LOSS_RATE * 100);

const usd = n => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

// These strings are printed verbatim on a paid report — "1 records" reads sloppy.
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The intake field is <input type="number">, but people paste "5,000" and "$5k".
function parseSelfReportedAvg(raw) {
  if (raw === null || raw === undefined) return 0;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Summaries created before this build (and the empty-board path) carry no
// `computed` block. Normalize to one shape so nothing downstream branches on it.
function normalizeComputed(crmSummary) {
  if (crmSummary?.computed) return crmSummary.computed;
  return {
    total_items: crmSummary?.totalItems || 0,
    stale_items_count: crmSummary?.staleItems || 0,
    closed_items_excluded: 0,
    stuck_deals_count: 0,
    stuck_deals_value: 0,
    revenue_leakage: 0,
    total_pipeline_value: 0,
    avg_deal_value: 0,
    closed_won_value: 0,
    open_items_count: crmSummary?.activeItems || 0,
    data_quality_score: crmSummary?.missingDataPercent != null ? 100 - crmSummary.missingDataPercent : null,
    owner_coverage_percent: null,
    avg_response_time_days: null,
    stage_distribution: {},
    stuck_deal_samples: [],
    value_column_name: null,
    value_column_confident: false,
    has_real_deal_values: false,
    health_score: null,
  };
}

// The headline number, decided in code. Claude never gets to set it — see the
// override in runClaudeAudit. Chain: real CRM values → self-reported avg → none.
function resolveLeakage(computed, avgDealInput) {
  const selfReportedAvg = parseSelfReportedAvg(avgDealInput);
  // A numeric column whose title never says "money" may be a count, a score, or a
  // phone number. Treat it as unverified rather than as deal values.
  const confident = computed.has_real_deal_values && computed.value_column_confident !== false;

  if (confident) {
    if (computed.stuck_deals_count > 0) {
      const col = computed.value_column_name ? ` (from your "${computed.value_column_name}" column)` : "";
      return {
        revenue_leakage: computed.revenue_leakage,
        confidence: "high",
        basis: "crm_deal_values",
        data_citation:
          `Based on ${plural(computed.stuck_deals_count, "stuck deal")} worth ${usd(computed.stuck_deals_value)}${col}, ` +
          `untouched for ${STALE_DAYS}+ days, at a ${LOSS_PCT}% loss rate for stalled deals.`,
      };
    }
    // Real values present and nothing has stalled: $0 is a finding, not a gap.
    return {
      revenue_leakage: 0,
      confidence: "high",
      basis: "crm_deal_values",
      data_citation:
        `No deals have stalled past ${STALE_DAYS} days across ${plural(computed.total_items, "record")} — ` +
        `pipeline hygiene is clean.`,
    };
  }

  // The client's own reported average beats a numeric column we could not verify.
  if (selfReportedAvg > 0 && computed.stale_items_count > 0) {
    const preamble =
      computed.has_real_deal_values && computed.value_column_name
        ? `The only numeric column found ("${computed.value_column_name}") does not appear to hold deal values, so it was not used. `
        : `No deal value column was detected in your CRM. `;
    return {
      revenue_leakage: Math.round(computed.stale_items_count * selfReportedAvg * STALL_LOSS_RATE),
      confidence: "medium",
      basis: "self_reported_avg",
      data_citation:
        preamble +
        `Based on ${plural(computed.stale_items_count, "record")} ` +
        `untouched for ${STALE_DAYS}+ days × ${usd(selfReportedAvg)} self-reported average deal value, ` +
        `at a ${LOSS_PCT}% loss rate for stalled deals.`,
    };
  }

  // Unverified numeric column and nothing self-reported. Use it, but say plainly
  // that we could not confirm it holds money.
  if (computed.has_real_deal_values && computed.stuck_deals_count > 0) {
    return {
      revenue_leakage: computed.revenue_leakage,
      confidence: "medium",
      basis: "unverified_numeric_column",
      data_citation:
        `Based on ${plural(computed.stuck_deals_count, "stuck record")} worth ` +
        `${usd(computed.stuck_deals_value)} in the "${computed.value_column_name}" column, untouched for ` +
        `${STALE_DAYS}+ days, at a ${LOSS_PCT}% loss rate. That column's name does not clearly indicate ` +
        `deal value — confirm it holds monetary amounts before relying on this figure.`,
    };
  }

  return {
    revenue_leakage: 0,
    confidence: "low",
    basis: "insufficient_data",
    data_citation:
      `Not enough data to quantify leakage: no deal value column was detected in your CRM and no ` +
      `average deal value was provided. Add a value column to your board and re-run the audit.`,
  };
}

// The prompt tells Claude the computed health score, so a faithful narrative quotes
// THAT number — while the box shows reconcileScore()'s output, which is allowed to
// differ. Observed live: narrative "a CRM health score of 30", box 28. Claude was not
// wrong; we changed the number after asking it. Realign the prose to what is shown.
//
// Deliberately narrow: only "health score" is matched. The narrative also quotes a
// data-quality score out of 100, and rewriting that to the health score would turn
// one cosmetic mismatch into a wrong number.
const HEALTH_SCORE_IN_TEXT_RE = /(health\s+score\s*(?:of|is|at|:)?\s*)(\d{1,3})\b/gi;

function alignScoreInNarrative(narrative, finalScore) {
  if (typeof narrative !== "string" || !Number.isFinite(finalScore)) return narrative;
  return narrative.replace(HEALTH_SCORE_IN_TEXT_RE, (match, prefix, stated) =>
    Number(stated) === finalScore ? match : `${prefix}${finalScore}`
  );
}

// Keep the reported score tethered to the computed health score. Claude may
// adjust it ±10 for qualitative factors; anything further is overruled.
function reconcileScore(modelScore, healthScore) {
  const n = Number.parseInt(modelScore, 10);
  if (healthScore === null || healthScore === undefined) {
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
  }
  if (!Number.isFinite(n)) return healthScore;
  return Math.max(10, Math.min(100, Math.min(Math.max(n, healthScore - 10), healthScore + 10)));
}

const SYSTEM_PROMPT = `You are a senior CRM revenue intelligence analyst.
You receive REAL CRM data — metrics computed from the client's actual records, not estimates.
Your job is to explain what the numbers mean and what to do about them.

CRITICAL RULES:
1. NEVER invent financial figures. Every dollar amount you state must either appear in COMPUTED CRM METRICS below, or be a clearly-labelled projection of one specific recommended action.
2. revenue_leakage is computed by code and supplied to you. Do NOT recalculate it and do NOT contradict it — explain it.
3. Distinguish computed fact from inferred pattern. Where the data does not support a claim, say so plainly instead of guessing.
4. Every recommendation must reference specific data from the input.
5. Write like a McKinsey partner presenting to a CEO — direct, specific, no filler.
6. Return ONLY valid JSON. No markdown, no code fences, no text outside the JSON.`;

function buildUserPrompt({ companyName, industry, teamSize, monthlyLeads, avgDeal, challenges }, crmSummary, computed, leakage) {
  const stages = Object.entries(computed.stage_distribution || {})
    .map(([stage, count]) => `- ${stage}: ${count} items`)
    .join("\n") || "- (no stage column detected)";

  const samples = (computed.stuck_deal_samples || [])
    .map(d => `- ${d.name}: ${d.days_stuck} days without an update (${usd(d.value)})`)
    .join("\n") || "- (none)";

  const confidenceNote = {
    high: "Deal values were read from the CRM. State the revenue figure with confidence.",
    medium: "No deal value column exists in the CRM; the figure uses the client's self-reported average deal value. Acknowledge this openly in the narrative.",
    low: "There is not enough data to quantify revenue leakage. Do NOT state a dollar figure for leakage. Make fixing the data gap the first recommendation.",
  }[leakage.confidence];

  return `Analyze this Monday.com CRM and generate a detailed audit.

COMPANY CONTEXT (self-reported by the client):
Company: ${companyName}
Industry: ${industry || "Not specified"}
Team size: ${teamSize || "Not specified"}
Monthly leads: ${monthlyLeads || "Not specified"}
Average deal value: ${avgDeal || "Not specified"}
Main challenges: ${(challenges || []).join(", ") || "Not specified"}

COMPUTED CRM METRICS — these are facts derived from the client's real records.
Use them. Do not recalculate them.
Records analyzed: ${computed.total_items} (${computed.open_items_count ?? "?"} open, the rest closed)
Open pipeline value (closed deals excluded): ${usd(computed.total_pipeline_value)}
Closed-won value on these boards: ${usd(computed.closed_won_value)}
Average OPEN deal value (from CRM): ${computed.has_real_deal_values ? usd(computed.avg_deal_value) : "not available — no value column detected"}
Records untouched for ${STALE_DAYS}+ days: ${computed.stale_items_count}
Closed deals excluded from that count: ${computed.closed_items_excluded ?? 0}
Stuck deals carrying a real value: ${computed.stuck_deals_count} (${usd(computed.stuck_deals_value)})
CRM health score: ${computed.health_score ?? "not available"}/100
Data quality score: ${computed.data_quality_score ?? "not available"}%
Owner coverage: ${computed.owner_coverage_percent ?? "not available"}%
Avg days from record creation to last activity: ${computed.avg_response_time_days ?? "not available"}

REVENUE LEAKAGE (computed — this exact number goes in the report):
${usd(leakage.revenue_leakage)}
Derivation: ${leakage.data_citation}
Data confidence: ${leakage.confidence}. ${confidenceNote}

STUCK DEAL SAMPLES:
${samples}

STAGE DISTRIBUTION:
${stages}

RAW BOARD SUMMARY (supporting context):
${JSON.stringify({ ...crmSummary, computed: undefined }, null, 2)}

Return JSON with exactly these keys:
{
  "score": <integer 0-100 — start from the computed health score of ${computed.health_score ?? "your own assessment"} and adjust by at most 10 points in either direction>,
  "revenue_leakage": ${leakage.revenue_leakage},
  "critical_issues": [<3 specific strings, each citing a number from the metrics above>],
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
  "narrative": "Two paragraphs. Executive summary tone. Reference the ${usd(leakage.revenue_leakage)} leakage figure and where it comes from. Sound like McKinsey."
}

If the narrative states the CRM health score as a number, it must be the exact integer
you put in the "score" field above — the report prints that value next to this text, so
any other number reads as a contradiction. Write "a CRM health score of 28 out of 100"
when your score field is 28. Do not round it and do not restate the computed ${computed.health_score ?? "input"} if you adjusted away from it.

Minimum 10 quick_wins, minimum 5 automation_gaps.
Each quick win's impact_usd must be a defensible fraction of a number given above — never a figure you invented.`;
}

async function runClaudeAudit({ crmSummary, companyName, industry, teamSize, monthlyLeads, avgDeal, challenges }) {
  const computed = normalizeComputed(crmSummary);
  const leakage = resolveLeakage(computed, avgDeal);

  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(
    { companyName, industry, teamSize, monthlyLeads, avgDeal, challenges },
    crmSummary,
    computed,
    leakage
  );

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

  let audit;
  try {
    audit = JSON.parse(text);
  } catch {
    // Strip any accidental markdown fences
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    audit = JSON.parse(clean);
  }

  // Code owns the numbers. The prompt already supplies revenue_leakage, but a
  // model that drifts must not be able to change the headline figure of a paid
  // report — so overwrite rather than trust.
  const score = reconcileScore(audit.score, computed.health_score);

  return {
    ...audit,
    score,
    // Belt-and-braces alongside the prompt rule below: the prose must not state a
    // health score the report contradicts.
    narrative: alignScoreInNarrative(audit.narrative, score),
    revenue_leakage: leakage.revenue_leakage,
    // Non-breaking additions: report.html ignores keys it doesn't know about.
    data_citation: leakage.data_citation,
    confidence: leakage.confidence,
    leakage_basis: leakage.basis,
    computed_metrics: computed,
  };
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
// Exported for tests — these decide the headline number, so they get exercised
// directly rather than only through a live Claude call.
module.exports.resolveLeakage = resolveLeakage;
module.exports.reconcileScore = reconcileScore;
module.exports.alignScoreInNarrative = alignScoreInNarrative;
module.exports.normalizeComputed = normalizeComputed;
module.exports.runClaudeAudit = runClaudeAudit;
