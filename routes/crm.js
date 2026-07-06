const express = require("express");
const router = express.Router();

// Monday.com GraphQL data fetch
router.post("/monday", async (req, res, next) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: "apiKey required" });

    // 1. Get all boards
    const boardsRes = await mondayQuery(apiKey, `{ boards(limit:50) { id name board_kind } }`);
    const boards = (boardsRes.data?.boards || []).filter(b => b.board_kind === "public");

    if (!boards.length) return res.json({ summary: buildEmptySummary() });

    // 2. Pull items from top 3 boards (by size)
    const boardIds = boards.slice(0, 3).map(b => b.id);
    const itemsQuery = `{
      boards(ids: [${boardIds.join(",")}]) {
        id name
        items_page(limit: 100) {
          items {
            id name state created_at updated_at
            column_values { id text type }
          }
        }
      }
    }`;
    const itemsRes = await mondayQuery(apiKey, itemsQuery);
    const fullBoards = itemsRes.data?.boards || [];

    const summary = buildSummary(boards, fullBoards);
    res.json({ summary, boards: boards.map(b => ({ id: b.id, name: b.name })) });
  } catch (err) {
    next(err);
  }
});

async function mondayQuery(apiKey, query) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Monday API error: ${res.status}`);
  return res.json();
}

function buildSummary(boards, fullBoards) {
  let totalItems = 0;
  let activeItems = 0;
  let staleItems = 0; // not updated in 30+ days
  let missingData = 0;
  const staleThreshold = Date.now() - 30 * 24 * 60 * 60 * 1000;

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
  };
}

module.exports = router;
