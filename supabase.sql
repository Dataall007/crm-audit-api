create table crm_audits (
  id uuid primary key default gen_random_uuid(),
  audit_id text unique not null,
  crm_type text default 'monday',
  company_name text,
  email text,
  audit_json jsonb,
  score integer,
  revenue_leakage numeric,
  paid boolean default false,
  created_at timestamptz default now()
);

create index on crm_audits (audit_id);
create index on crm_audits (email);
