const express = require("express");
const router = express.Router();

// v2 (Phase B): pull item-level detail so the revenue figure is COMPUTED from real
// deal values instead of estimated by the model. The column title lets us name the
// value column in the report citation; `value` is the raw JSON fallback for columns
// whose `text` is empty or locale-formatted.
//
// The title MUST come from the nested `column { title }` — `ColumnValue` has no
// `title` field of its own on API 2024-01, and asking for one fails the whole query.
const MONDAY_RICH_QUERY = `
  query getRichBoardData($boardIds: [ID!]!) {
    boards(ids: $boardIds) {
      id name
      items_page(limit: 200) {
        items {
          id name state created_at updated_at
          column_values { id text type value column { title } }
        }
      }
    }
  }
`;

// Accepts either shape: nested (what the API returns) or flat (test fixtures).
const titleOf = col => col?.column?.title || col?.title || "";

const STALE_DAYS = 30;

// Snapshot × loss rate — deliberately NOT × 12. stuck_deals is a point-in-time
// count, so annualizing it would assert that a fresh cohort of the same size stalls
// every month (14 deals × $4k × 12 = $672k on a 50-item board). ~60% of B2B pipeline
// stalled past 30 days is eventually lost, which is a claim that survives a CFO
// asking "where does that number come from?".
const STALL_LOSS_RATE = 0.6;

// A column only counts as MONEY if its title says so. Matching bare `type:"numbers"`
// is how a board's "כמות פניות" (inquiry count) and even "טלפון הנהח״ש" (a phone
// number) end up reported as average deal value — with high confidence.
// Hebrew terms are first-class here: the target market's boards are in Hebrew.
const VALUE_TITLE_RE =
  /value|amount|revenue|deal|price|budget|sum|total|סכום|שווי|ערך|מחיר|תקציב|עלות|הכנסה/i;

// Monday returns "people" on API 2024-01; older boards still report "person".
const OWNER_TYPES = new Set(["people", "person"]);
const STAGE_TITLE_RE = /stage|status|phase|pipeline|סטטוס|סטאטוס|שלב/i;

// A deal that closed 90 days ago is finished, not stalled. Counting it as revenue
// at risk inflates the headline number with exactly the error a customer spots on
// the first read. Word boundaries so a stage like "Wonder Deals" isn't swallowed
// (Hebrew has no \b equivalent here, so those alternatives are matched as-is).
const CLOSED_STAGE_RE =
  /\b(won|lost|closed|cancel(l?ed)?|dead)\b|נסגר|סגור|בוטל|מבוטל|זכינו|הפסדנו|אבוד/i;

// Won is reported on its own — it is the one closed state that represents money
// actually earned, and it reads well next to the at-risk figure.
const WON_STAGE_RE = /\bwon\b|זכינו|נסגר בהצלחה/i;

// Board ranking. Picking the first three boards the API happens to return analyzed
// support boards on a real account while the actual `Deals 💰` board was ignored —
// and ranking by item count is worse still, since the two biggest boards there were
// a task tracker and a contact list whose only numeric column held phone numbers.
const PIPELINE_NAME_RE = /deal|pipeline|sales|opportunit|revenue|דיל|עסקאות|מכירות/i;
const LEAD_NAME_RE = /lead|prospect|crm|ליד|לקוחות פוטנציאלי/i;
const BOARDS_TO_ANALYZE = 3;

// Monday.com GraphQL data fetch
router.post("/monday", async (req, res, next) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: "apiKey required" });

    // 1. Get all boards, with enough metadata to rank them without a second call
    const boardsRes = await mondayQuery(
      apiKey,
      `{ boards(limit:50) { id name board_kind type items_count columns { id title type } } }`
    );
    const boards = (boardsRes.data?.boards || []).filter(b => b.board_kind === "public");

    if (!boards.length) return res.json({ summary: buildEmptySummary() });

    // 2. Pull items from the boards most likely to BE a sales pipeline
    const ranked = rankBoards(boards);
    if (!ranked.length) return res.json({ summary: buildEmptySummary() });

    const boardIds = ranked.slice(0, BOARDS_TO_ANALYZE).map(b => b.id);
    const itemsRes = await mondayQuery(apiKey, MONDAY_RICH_QUERY, { boardIds });
    const fullBoards = itemsRes.data?.boards || [];

    const summary = buildSummary(boards, fullBoards);
    // audit.html forwards `summary` verbatim as `crmSummary`, so nesting the computed
    // metrics inside it carries them to POST /api/audit with no frontend change.
    summary.computed = computeCrmMetrics(fullBoards);

    res.json({ summary, boards: boards.map(b => ({ id: b.id, name: b.name })) });
  } catch (err) {
    next(err);
  }
});

async function mondayQuery(apiKey, query, variables) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
      "API-Version": "2024-01",
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  if (!res.ok) throw new Error(`Monday API error: ${res.status}`);

  // Monday answers a malformed query with HTTP 200 and an `errors` array. Left
  // unchecked, `data` is null, the summary comes back with zero items, and the
  // client is handed a plausible-looking audit reporting nothing. Fail loudly.
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Monday GraphQL error: ${json.errors.map(e => e.message).join("; ")}`);
  }
  if (json.error_message) throw new Error(`Monday API error: ${json.error_message}`);
  return json;
}

// Score boards on how much they look like a sales pipeline, then take the top few.
// Name is the strongest signal, a money-titled column next; item count only breaks
// ties, so a 68-item task tracker never outranks a 6-item deals board.
function rankBoards(boards) {
  return boards
    .filter(b => b.type !== "sub_items_board" && (b.items_count || 0) > 0)
    .map(b => {
      const columns = b.columns || [];
      let score = 0;

      if (PIPELINE_NAME_RE.test(b.name || "")) score += 5;
      else if (LEAD_NAME_RE.test(b.name || "")) score += 3;

      const hasMoneyColumn = columns.some(
        c => c.type === "numbers" && VALUE_TITLE_RE.test(c.title || "")
      );
      if (hasMoneyColumn) score += 4;
      if (columns.some(c => c.type === "status")) score += 1;

      return { ...b, score };
    })
    .sort((a, b) => b.score - a.score || (b.items_count || 0) - (a.items_count || 0));
}

function buildSummary(boards, fullBoards) {
  let totalItems = 0;
  let activeItems = 0;
  let staleItems = 0; // not updated in 30+ days
  let missingData = 0;
  const staleThreshold = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

  const boardSummaries = fullBoards.map(board => {
    const items = board.items_page?.items || [];
    totalItems += items.length;

    items.forEach(item => {
      if (item.state === "active") activeItems++;
      const updated = new Date(item.updated_at).getTime();
      if (updated < staleThreshold) staleItems++;
      const emptyFields = item.column_values.filter(c => !c.text || c.text.trim() === "").length;
      if (emptyFields > item.column_values.length * 0.4) missingData++;
    });

    return {
      name: board.name,
      itemCount: items.length,
      sampleItems: items.slice(0, 5).map(i => ({
        name: i.name,
        state: i.state,
        updatedAt: i.updated_at,
        filledFields: i.column_values.filter(c => c.text).length,
        totalFields: i.column_values.length,
      })),
    };
  });

  return {
    totalBoards: boards.length,
    analyzedBoards: fullBoards.length,
    totalItems,
    activeItems,
    staleItems,
    missingDataItems: missingData,
    stalePercent: totalItems ? Math.round((staleItems / totalItems) * 100) : 0,
    missingDataPercent: totalItems ? Math.round((missingData / totalItems) * 100) : 0,
    boardSummaries,
  };
}

function buildEmptySummary() {
  return {
    totalBoards: 0, analyzedBoards: 0, totalItems: 0,
    activeItems: 0, staleItems: 0, missingDataItems: 0,
    stalePercent: 0, missingDataPercent: 0, boardSummaries: [],
    computed: emptyComputed(),
  };
}

// ---------------------------------------------------------------------------
// computeCrmMetrics — the numbers the audit is allowed to state as fact.
// Everything here is derived from real board data; Claude explains it, never
// recalculates it (see routes/audit.js).
// ---------------------------------------------------------------------------

function parseAmount(col) {
  if (!col) return null;
  if (col.text) {
    const n = parseFloat(String(col.text).replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  // Some column types return an empty `text` and keep the number in raw JSON.
  if (col.value) {
    try {
      const v = JSON.parse(col.value);
      const raw = v && typeof v === "object" ? (v.number ?? v.value ?? v.amount) : v;
      const n = parseFloat(raw);
      if (Number.isFinite(n)) return n;
    } catch {
      // not JSON — no amount to read
    }
  }
  return null;
}

// Pick ONE value column per board rather than per item. A per-item `find` can latch
// onto a different column on every row, silently skewing the average the headline
// number is built from.
//
// `strong` = the title actually says money. A bare numbers column is kept only as a
// last resort and flagged, because "high confidence" on an inquiry-count column is
// worse than an honest estimate.
function detectValueColumn(items) {
  const candidates = new Map();

  for (const item of items) {
    for (const col of item.column_values || []) {
      const title = titleOf(col);
      const strong = VALUE_TITLE_RE.test(title);
      if (!strong && col.type !== "numbers") continue;
      const amount = parseAmount(col);
      if (amount === null || amount <= 0) continue;

      const entry = candidates.get(col.id) || { id: col.id, title: title || col.id, strong, count: 0 };
      entry.count++;
      candidates.set(col.id, entry);
    }
  }

  const all = [...candidates.values()];
  const strongOnes = all.filter(c => c.strong);
  return (strongOnes.length ? strongOnes : all).sort((a, b) => b.count - a.count)[0] || null;
}

function computeCrmMetrics(boards) {
  const now = new Date();
  const boardList = boards || [];
  const items = boardList.flatMap(b => b.items_page?.items || []);
  if (!items.length) return emptyComputed(now);

  const daysSince = ts => {
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? (now.getTime() - t) / 86400000 : null;
  };

  // Column ids are board-scoped, so detect per board: pooling every item first would
  // make two boards' deal-value columns compete and only the winner's deals would be
  // counted. When at least one board offers a money-titled column, boards that could
  // only offer a bare numeric column are dropped rather than mixed in.
  const perBoard = boardList.map(b => {
    const boardItems = b.items_page?.items || [];
    return { items: boardItems, column: detectValueColumn(boardItems) };
  });
  const anyStrong = perBoard.some(x => x.column?.strong);
  const usable = perBoard.filter(x => x.column && (!anyStrong || x.column.strong));

  const valueByItem = new Map();
  for (const { items: boardItems, column } of usable) {
    for (const item of boardItems) {
      const amount = parseAmount((item.column_values || []).find(c => c.id === column.id));
      if (amount && amount > 0) valueByItem.set(item.id, amount);
    }
  }
  const valueOf = item => valueByItem.get(item.id) || 0;

  // Case-insensitive dedupe: two boards naming the same column "Deal Value" and
  // "Deal value" would otherwise print as "Deal Value / Deal value" in the citation.
  const valueColumnNames = [
    ...new Map(usable.map(x => [x.column.title.toLowerCase(), x.column.title])).values(),
  ];
  const valueColumnConfident = anyStrong;

  const stageOf = item =>
    (item.column_values || [])
      .find(c => c.type === "status" || STAGE_TITLE_RE.test(titleOf(c)))
      ?.text?.trim() || "";
  const isClosed = item => CLOSED_STAGE_RE.test(stageOf(item));

  // --- Financial -----------------------------------------------------------
  // Pipeline means OPEN deals. A Closed-Won deal is booked revenue and a Closed-Lost
  // one is gone; counting either inflates both the pipeline total and the average
  // that the narrative quotes back to the client.
  const openItems = items.filter(i => !isClosed(i));
  const openDealValues = openItems.map(valueOf).filter(v => v > 0);
  const totalPipelineValue = Math.round(openDealValues.reduce((a, b) => a + b, 0));
  const avgDealValue = openDealValues.length
    ? Math.round(totalPipelineValue / openDealValues.length)
    : 0;

  const closedWonValue = Math.round(
    items.filter(i => WON_STAGE_RE.test(stageOf(i))).reduce((sum, i) => sum + valueOf(i), 0)
  );

  // Detection of "does this CRM track deal values at all" must look at EVERY item,
  // not just open ones — otherwise a board where everything is already closed
  // reports no value column and drops to the self-reported fallback.
  const hasAnyDealValue = items.some(i => valueOf(i) > 0);

  // staleItems is tracked separately from stuckDeals because audit.js falls back
  // to the self-reported avg deal value when the board has no value column — and
  // that fallback needs a count that isn't itself gated on having a value.
  // Closed deals are dropped before either: they are old on purpose, so leaving
  // them in would overstate leakage AND depress the health score.
  const agedItems = items.filter(i => (daysSince(i.updated_at) ?? 0) > STALE_DAYS);
  const closedItemsExcluded = agedItems.filter(isClosed).length;
  const staleItems = agedItems.filter(i => !isClosed(i));
  const stuckDeals = staleItems.filter(i => valueOf(i) > 0);

  // Sum the actual values of the stuck deals rather than count × average: when
  // deal sizes are skewed, the average misstates what is really at risk.
  const stuckDealsValue = Math.round(stuckDeals.reduce((sum, i) => sum + valueOf(i), 0));
  const revenueLeakage = Math.round(stuckDealsValue * STALL_LOSS_RATE);

  // --- Quality -------------------------------------------------------------
  const allColumns = items.flatMap(i => i.column_values || []);
  const filledColumns = allColumns.filter(c => c.text && c.text.trim() !== "").length;
  const dataQualityScore = allColumns.length
    ? Math.round((filledColumns / allColumns.length) * 100)
    : 0;

  const itemsWithOwner = items.filter(i =>
    (i.column_values || []).some(c => OWNER_TYPES.has(c.type) && c.text && c.text.trim() !== "")
  ).length;
  const ownerCoveragePercent = Math.round((itemsWithOwner / items.length) * 100);

  // Days from creation to the most recent touch. Not literally first-response
  // time — Monday exposes no first-touch timestamp — so read it as deal age at
  // last activity, and keep the framing honest in the report.
  const responseTimes = items
    .map(i => {
      const created = new Date(i.created_at).getTime();
      const updated = new Date(i.updated_at).getTime();
      return Number.isFinite(created) && Number.isFinite(updated) ? (updated - created) / 86400000 : null;
    })
    .filter(d => d !== null && d > 0 && d < 365);
  const avgResponseTimeDays = responseTimes.length
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : null;

  // --- Stage distribution --------------------------------------------------
  const stageDistribution = {};
  for (const item of items) {
    const stage = stageOf(item) || "Unknown";
    stageDistribution[stage] = (stageDistribution[stage] || 0) + 1;
  }

  // --- Health score --------------------------------------------------------
  let healthScore = 70;
  if (dataQualityScore < 60) healthScore -= 15;
  if (dataQualityScore > 80) healthScore += 10;
  if (ownerCoveragePercent < 70) healthScore -= 10;
  if (staleItems.length > items.length * 0.3) healthScore -= 15;
  if (avgResponseTimeDays && avgResponseTimeDays > 7) healthScore -= 10;
  healthScore = Math.max(10, Math.min(100, healthScore));

  const hasRealDealValues = hasAnyDealValue;

  return {
    // Meta
    analysis_date: now.toISOString(),
    crm_type: "monday",

    // Volume
    total_boards_analyzed: (boards || []).length,
    total_items: items.length,

    // Financial (real numbers, or zeros + a medium-confidence fallback in audit.js)
    total_pipeline_value: totalPipelineValue, // open deals only
    avg_deal_value: avgDealValue, // open deals only
    closed_won_value: closedWonValue,
    open_items_count: openItems.length,
    stale_items_count: staleItems.length,
    closed_items_excluded: closedItemsExcluded,
    stuck_deals_count: stuckDeals.length,
    stuck_deals_value: stuckDealsValue,
    revenue_leakage: revenueLeakage,
    stall_loss_rate: STALL_LOSS_RATE,
    stale_days_threshold: STALE_DAYS,
    leakage_basis: hasRealDealValues ? "crm_deal_values" : "none",

    // Quality
    health_score: healthScore,
    data_quality_score: dataQualityScore,
    owner_coverage_percent: ownerCoveragePercent,
    avg_response_time_days: avgResponseTimeDays,

    // Stage distribution
    stage_distribution: stageDistribution,

    // Samples (context for the narrative)
    stuck_deal_samples: stuckDeals
      .sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at))
      .slice(0, 5)
      .map(d => ({
        name: d.name,
        days_stuck: Math.round(daysSince(d.updated_at) || 0),
        value: Math.round(valueOf(d)),
      })),

    // Flags
    value_column_name: valueColumnNames.join(" / ") || null,
    value_column_confident: valueColumnConfident,
    has_real_deal_values: hasRealDealValues,
    confidence: hasRealDealValues ? (valueColumnConfident ? "high" : "medium") : "medium",
  };
}

function emptyComputed(now = new Date()) {
  return {
    analysis_date: now.toISOString(),
    crm_type: "monday",
    total_boards_analyzed: 0,
    total_items: 0,
    total_pipeline_value: 0,
    avg_deal_value: 0,
    closed_won_value: 0,
    open_items_count: 0,
    stale_items_count: 0,
    closed_items_excluded: 0,
    stuck_deals_count: 0,
    stuck_deals_value: 0,
    revenue_leakage: 0,
    stall_loss_rate: STALL_LOSS_RATE,
    stale_days_threshold: STALE_DAYS,
    leakage_basis: "none",
    health_score: 0,
    data_quality_score: 0,
    owner_coverage_percent: 0,
    avg_response_time_days: null,
    stage_distribution: {},
    stuck_deal_samples: [],
    value_column_name: null,
    value_column_confident: false,
    has_real_deal_values: false,
    confidence: "low",
  };
}

module.exports = router;
module.exports.computeCrmMetrics = computeCrmMetrics;
module.exports.STALL_LOSS_RATE = STALL_LOSS_RATE;
module.exports.STALE_DAYS = STALE_DAYS;
