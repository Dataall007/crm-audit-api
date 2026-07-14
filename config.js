// Central resolution of Supabase credentials.
//
// The canonical env var names are SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY,
// but this deployment's Render environment exposes them under different names
// (SUPABASE_PROJECT_URL / SUPABASE_agent7d_service_role). Prefer the canonical
// names when present, otherwise fall back to the deployed ones — so the app
// works in both without duplicating this logic across every route.
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL ||
  null;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_agent7d_service_role ||
  null;

module.exports = { SUPABASE_URL, SUPABASE_KEY };
