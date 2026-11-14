-- Human recovery results from the two "find the hidden planet" games: the
-- PlanetX Planted Lab (game 'lab') and the viewer quest (game 'quest'). Each
-- round is an agent_records row of kind 'recovery' whose payload holds only
-- {game, peakSigma, found, misses, voter, mag?, distanceAu?, baselineDays?}.
-- voter is a random browser id; nothing personal is stored, and only the
-- binned totals below are ever read back.
alter table public.agent_records drop constraint if exists agent_records_kind_check;
alter table public.agent_records add constraint agent_records_kind_check check (kind in ('patrol', 'case', 'report', 'vote', 'finding', 'recovery'));

create index if not exists agent_records_recovery_idx on public.agent_records (created_at desc) where kind = 'recovery';

-- Rounds per game and whole-σ brightness bin (peak over single-frame noise).
create or replace view public.planetx_recovery_tally as
select payload->>'game' as game,
  floor((payload->>'peakSigma')::double precision)::int as sigma,
  count(*)::int as trials,
  count(*) filter (where (payload->>'found')::boolean)::int as found
from public.agent_records
where kind = 'recovery' and payload->>'game' in ('lab', 'quest') and payload ? 'peakSigma'
group by 1, 2;

-- Lab rounds on the Lab's own distance × magnitude grid: magnitude to the
-- nearest 0.25, distance to the nearest grid distance (in log space).
create or replace view public.planetx_recovery_lab_cells as
select round(((payload->>'mag')::double precision * 4)::numeric) / 4 as mag,
  grid.distance_au,
  count(*)::int as trials,
  count(*) filter (where (payload->>'found')::boolean)::int as found
from public.agent_records
cross join lateral (
  select d as distance_au from unnest(array[50, 100, 200, 400, 700, 1000, 1500]) as d
  order by abs(ln(d) - ln((payload->>'distanceAu')::double precision)) limit 1
) as grid
where kind = 'recovery' and payload->>'game' = 'lab' and payload ? 'mag' and (payload->>'distanceAu')::double precision > 0
group by 1, 2;

revoke all on public.planetx_recovery_tally from public, anon, authenticated;
revoke all on public.planetx_recovery_lab_cells from public, anon, authenticated;
grant select on public.planetx_recovery_tally to service_role;
grant select on public.planetx_recovery_lab_cells to service_role;
