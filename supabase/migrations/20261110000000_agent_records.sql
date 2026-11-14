-- Records the AI guide saves: patrol results (where it searched and what it
-- found, including nothing), spot case files, and "Think you've got one?"
-- reports visitors send for the team to review. Positions and measurements
-- only; no names, emails or other personal data are stored.
create table if not exists public.agent_records (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('patrol', 'case', 'report')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  ra_deg double precision,
  dec_deg double precision,
  status text not null default 'new' check (status in ('new', 'reviewed', 'artefact', 'known', 'follow-up')),
  created_at timestamptz not null default now()
);

create index if not exists agent_records_kind_created_idx on public.agent_records (kind, created_at desc);

alter table public.agent_records enable row level security;
revoke all on public.agent_records from public, anon, authenticated;
grant select, insert, update on public.agent_records to service_role;
