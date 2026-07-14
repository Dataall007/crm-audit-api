// Central resolution of Supabase credentials.
//
// The canonical env var names are SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY,
// but this deployment's Render environment exposes them under different names.
// Prefer canonical names, otherwise fall back to the deployed ones — so the app
// works in both without duplicating this logic across every route.
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL ||
  null;

// NOTE: on Render, SUPABASE_agent7d_service_role is misnamed — it actually holds
// an *anon* key (verified via JWT role claim), which is subject to RLS and can't
// insert. The real full-access key is SUPABASE_agent7d_secret_keys (an sb_secret_
// key that bypasses RLS). Use that; never fall back to the misnamed anon var.
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_agent7d_secret_keys ||
  null;

module.exports = { SUPABASE_URL, SUPABASE_KEY };
