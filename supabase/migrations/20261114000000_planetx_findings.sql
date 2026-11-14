-- PlanetX case-file submissions. Each is an agent_records row of kind
-- 'finding' whose payload holds only {caseId, verdict, voter, answers, ai,
-- spot, raDeg?, decDeg?}: the person's answer per AI suspect, their verdict,
-- the AI's read of the same spot if they looked, and the spot position. No
-- free text; voter is a random browser id and is never returned by the API.
--
-- caseId is "p9-…" for a public suspicion patch or "t9-…" for any other 5°
-- tile. Votes on "t9-" tiles are counted by planetx_vote_tally like any other
-- case, so the team can see which tiles are worth promoting.
alter table public.agent_records drop constraint if exists agent_records_kind_check;
alter table public.agent_records add constraint agent_records_kind_check check (kind in ('patrol', 'case', 'report', 'vote', 'finding'));

create index if not exists agent_records_finding_case_idx on public.agent_records ((payload->>'caseId'), created_at desc) where kind = 'finding';
