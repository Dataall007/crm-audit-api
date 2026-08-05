#!/usr/bin/env node
//
// Compares the FIELD NAMES computeCrmMetrics() actually returns against the field
// table in hq/products/crm-audit/prompts/audit-system.md.
//
//   node scripts/check-schema-doc.js
//
// Run before committing a change to routes/crm.js or to audit-system.md.
// Exits 1 on a mismatch so it can be wired into CI later; nothing runs it today.
//
// Deliberately compares NAMES, not the function body. A body diff would fire on
// every cosmetic refactor and get muted within a week. The failure this catches is
// the one that has actually happened three times: a field is added, renamed or
// dropped in code and the documentation silently keeps describing the old shape.
//
// SCHEMA_DOC and CRM_MODULE override the two inputs — used to prove this script
// actually fails when it should, against deliberately broken copies.

const fs = require("fs");
const path = require("path");

const DOC =
  process.env.SCHEMA_DOC ||
  path.resolve(__dirname, "../../hq/products/crm-audit/prompts/audit-system.md");

const SECTION = "## What `computeCrmMetrics()` returns";

// A board with every shape the function branches on: an open valued deal, a stale
// one, a closed-won one, a lost one, an owner, a stage. A thin fixture would leave
// branches unexercised and the key set incomplete.
const days = n => new Date(Date.now() - n * 86400000).toISOString();
const deal = (name, updated, amount, stage, owner) => ({
  id: name,
  name,
  state: "active",
  created_at: days(200),
  updated_at: updated,
  column_values: [
    { id: "num", type: "numbers", text: String(amount), value: JSON.stringify(String(amount)), column: { title: "Deal Value" } },
    { id: "st", type: "status", text: stage, value: null, column: { title: "Stage" } },
    { id: "own", type: "people", text: owner, value: null, column: { title: "Owner" } },
  ],
});

const FIXTURE = [
  {
    id: 1,
    name: "Deals",
    items_page: {
      items: [
        deal("Stuck deal", days(90), 12000, "Negotiation", "Dana"),
        deal("Fresh deal", days(2), 8000, "Proposal", ""),
        deal("Booked", days(90), 90000, "Closed Won", "Dana"),
        deal("Gone", days(120), 5000, "Lost", ""),
      ],
    },
  },
];

function fieldsFromCode() {
  const { computeCrmMetrics } = require(process.env.CRM_MODULE || "../routes/crm.js");
  if (typeof computeCrmMetrics !== "function") {
    throw new Error("routes/crm.js does not export computeCrmMetrics");
  }
  return {
    populated: Object.keys(computeCrmMetrics(FIXTURE)),
    // The zero-item path builds its object separately, so it can drift from the
    // main return on its own. Same contract, so hold it to the same field list.
    empty: Object.keys(computeCrmMetrics([])),
  };
}

// Field names alone miss a whole class of drift: flip STALL_LOSS_RATE from 0.6 to
// 0.5 and every name still matches while the documented figure is now wrong. These
// two constants are quoted in the doc, so they can be compared directly.
const CONSTANTS = [
  { exported: "STALL_LOSS_RATE", field: "stall_loss_rate" },
  { exported: "STALE_DAYS", field: "stale_days_threshold" },
];

function checkConstants(doc) {
  const code = require(process.env.CRM_MODULE || "../routes/crm.js");
  const problems = [];

  for (const { exported, field } of CONSTANTS) {
    const actual = code[exported];
    if (actual === undefined) {
      problems.push(`${exported} is no longer exported from crm.js`);
      continue;
    }
    // The table row states the value in its second cell: | `stall_loss_rate` | `0.6` | … |
    // Match on the FIRST cell: a field name also appears inside other rows'
    // explanations, and matching anywhere picks up the wrong row.
    const row = doc.split(/\r?\n/).find(l =>
      l.trimStart().startsWith("|") && (l.split("|")[1] || "").includes(`\`${field}\``)
    );
    if (!row) {
      problems.push(`${field} has no row in the field table`);
      continue;
    }
    const stated = (row.split("|")[2] || "").match(/`([\d.]+)`/);
    if (!stated) {
      problems.push(`${field} row does not state a numeric value`);
    } else if (Number(stated[1]) !== actual) {
      problems.push(`${field}: doc says ${stated[1]}, code says ${actual}`);
    }
  }

  // The headline formula is spelled out in prose too, and is the line a reader is
  // most likely to quote. Keep it honest as well.
  const formula = doc.match(/stuck_deals_value\s*[×x*]\s*([\d.]+)/);
  if (!formula) {
    problems.push("the revenue_leakage formula line is missing from the doc");
  } else if (Number(formula[1]) !== code.STALL_LOSS_RATE) {
    problems.push(`formula line says × ${formula[1]}, STALL_LOSS_RATE is ${code.STALL_LOSS_RATE}`);
  }

  return problems;
}

function fieldsFromDoc() {
  if (!fs.existsSync(DOC)) throw new Error(`doc not found: ${DOC}`);
  const lines = fs.readFileSync(DOC, "utf8").split(/\r?\n/);

  const start = lines.findIndex(l => l.trim() === SECTION);
  if (start === -1) throw new Error(`section not found in doc: ${SECTION}`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;

  const names = new Set();
  for (const line of lines.slice(start, end)) {
    if (!line.trimStart().startsWith("|")) continue;
    // First cell only. Later cells hold example values (`high`, `none`) that are
    // not field names. Escaped pipes appear after cell 1, so a plain split is safe.
    const cell = line.split("|")[1];
    if (!cell || /^[\s:-]*$/.test(cell)) continue; // header separator
    for (const m of cell.matchAll(/`([a-z_][a-z0-9_]*)`/gi)) names.add(m[1]);
  }
  return [...names];
}

function main() {
  const code = fieldsFromCode();
  const doc = fieldsFromDoc();
  const constantProblems = checkConstants(fs.readFileSync(DOC, "utf8"));

  const missingFromDoc = code.populated.filter(f => !doc.includes(f));
  const staleInDoc = doc.filter(f => !code.populated.includes(f));
  const emptyPathDrift = [
    ...code.populated.filter(f => !code.empty.includes(f)).map(f => `${f} (missing from the zero-item path)`),
    ...code.empty.filter(f => !code.populated.includes(f)).map(f => `${f} (only in the zero-item path)`),
  ];

  console.log(`code: ${code.populated.length} fields   doc: ${doc.length} fields`);
  console.log(`doc:  ${DOC}`);
  console.log();

  const report = (label, items) => {
    if (!items.length) return true;
    console.log(`${label}`);
    items.forEach(f => console.log(`  - ${f}`));
    console.log();
    return false;
  };

  const ok = [
    report("IN CODE, NOT DOCUMENTED — add a row to the table:", missingFromDoc),
    report("IN THE DOC, NOT IN CODE — the field was removed or renamed:", staleInDoc),
    report("THE TWO RETURN PATHS DISAGREE:", emptyPathDrift),
    report("CONSTANTS DISAGREE WITH THE DOC:", constantProblems),
  ].every(Boolean);

  if (ok) {
    console.log(`OK — field table matches computeCrmMetrics(), and ${CONSTANTS.map(c => c.exported).join(" / ")} match the documented values.`);
    process.exit(0);
  }
  console.log("Mismatch. The code is the source of truth; update the doc to match.");
  process.exit(1);
}

main();
