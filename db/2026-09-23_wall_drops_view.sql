-- Monitoring surface for the send-wall's false drops (FM-43).
--
-- WHY THIS EXISTS: between 16 and 22 Sep 2026 the brand wall silently dropped
-- six consecutive morning briefs and four list requests. Every drop wrote an
-- audit row here and paged a WhatsApp thread nobody reads, so the outage ran
-- for six days. An external monitor needs to COUNT those drops every few
-- minutes. It does not need, and must never get, the message bodies.
--
-- Hence a view, not a grant on chat_messages. `anon` stays locked out of the
-- table (it is today: SELECT returns 42501). The view exposes exactly two
-- things -- when a drop happened and which guard fired -- and nothing else.
-- Jensen's tasks, emails and contacts are not reachable through it.
--
-- Postgres views run with the OWNER's privileges unless security_invoker is
-- set, so granting SELECT on the view does not grant anything on the table.

create or replace view public.wall_drops as
select
  ts,
  -- "pre_send_caught[dropped->dev,graceful->jensen]: forbidden_brand:zanii | <body>"
  -- -> "forbidden_brand:zanii". Body is discarded here and never leaves the DB.
  substring(content from 'pre_send_caught[^:]*:\s*([a-z_]+:[A-Za-z_]+)') as guard
from public.chat_messages
where channel = 'audit'
  and content like 'pre_send_caught%';

comment on view public.wall_drops is
  'Read-only monitoring surface: one row per client-facing reply killed by the send wall. Timestamp + guard label only, never the body. Consumed by health.zanii.agency (FM-43).';

-- The monitor authenticates as anon and can only ever SELECT this view.
grant select on public.wall_drops to anon;

-- Rollback:
--   revoke select on public.wall_drops from anon;
--   drop view public.wall_drops;
