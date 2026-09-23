-- ADR-0002 Phase 1 — the real Law 8 confirm layer (Class C1: model self-confirm).
-- A durable record of a PROPOSED destructive action. The gate writes a row when
-- the model proposes a destructive tool without confirm; a DETERMINISTIC
-- confirm-router (not the model) executes it only when a DISTINCT user inbound
-- confirms (confirm_inbound_id <> proposed_inbound_id). This removes the model
-- from the confirm decision and kills same-turn self-confirmation.
--
-- Staged 2026-06-23. Safe to run anytime: additive, nothing reads it until the
-- Phase-1 code ships behind a fail-safe (table-absent => current behavior).

create table if not exists pending_actions (
  id                  uuid primary key default gen_random_uuid(),
  party               text        not null,                 -- 'jensen' | 'taona'
  tool                text        not null,                 -- the destructive tool name
  args                jsonb       not null default '{}'::jsonb,
  args_hash           text        not null,                 -- stable hash of (tool,args) for idempotency
  proposed_inbound_id text,                                 -- inbound message id that PROPOSED the action
  status              text        not null default 'pending'
                        check (status in ('pending','confirmed','executed','expired','cancelled')),
  confirm_inbound_id  text,                                 -- the DISTINCT inbound that confirmed (must differ from proposed)
  result              jsonb,                                -- execution result once run
  error               text,                                 -- execution error if it failed
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null default (now() + interval '30 minutes')
);

-- The confirm-router looks up the latest still-pending, non-expired proposal for a party.
create index if not exists pending_actions_party_status_idx
  on pending_actions (party, status, created_at desc);

-- Idempotency guard: at most one OPEN proposal per (party, tool, args_hash) at a time.
create unique index if not exists pending_actions_open_uniq
  on pending_actions (party, tool, args_hash)
  where status = 'pending';
