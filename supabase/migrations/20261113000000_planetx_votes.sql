-- PlanetX community votes on suspicion case files. Each vote is an
-- agent_records row of kind 'vote' whose payload holds only
-- {caseId, verdict: 'something' | 'nothing', voter, raDeg?, decDeg?}; voter is
-- a random id the browser keeps, not personal data. A browser that changes its
-- mind adds a new row, and only its latest vote per case is counted.
alter table public.agent_records drop constraint if exists agent_records_kind_check;
alter table public.agent_records add constraint agent_records_kind_check check (kind in ('patrol', 'case', 'report', 'vote'));

create index if not exists agent_records_vote_case_idx on public.agent_records ((payload->>'caseId'), created_at desc) where kind = 'vote';

create or replace view public.planetx_vote_tally as
with latest as (
  select distinct on (payload->>'caseId', payload->>'voter')
    payload->>'caseId' as case_id,
    payload->>'verdict' as verdict
  from public.agent_records
  where kind = 'vote'
  order by payload->>'caseId', payload->>'voter', created_at desc
)
select case_id,
  count(*) filter (where verdict = 'something')::int as something,
  count(*) filter (where verdict = 'nothing')::int as nothing
from latest
group by case_id;

revoke all on public.planetx_vote_tally from public, anon, authenticated;
grant select on public.planetx_vote_tally to service_role;
