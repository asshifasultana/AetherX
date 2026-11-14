create table if not exists public.star_profiles (
  id text primary key,
  lookup_keys jsonb not null check (jsonb_typeof(lookup_keys) = 'array'),
  profile jsonb not null check (jsonb_typeof(profile) = 'object')
);

create index if not exists star_profiles_lookup_idx
  on public.star_profiles using gin (lookup_keys jsonb_path_ops);

alter table public.star_profiles enable row level security;
revoke all on public.star_profiles from public, anon, authenticated;
grant select, insert, update on public.star_profiles to service_role;
