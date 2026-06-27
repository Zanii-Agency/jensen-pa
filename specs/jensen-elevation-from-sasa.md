# Jensen / Dorje Elevation Plan — porting Sasa's architecture, tuned to Jensen's real wounds

> Grounded in: full Sasa arch map (nisria-sr), full Jensen arch map (jensen-pa), and the
> complete `chat_messages` production transcript (479 owner rows, 2026-06-05 → 06-27).
> Status: PLAN (Tier 1). No code written yet. Aligns with existing ADR-0002.

## The reframe (why we are NOT just copy-pasting Sasa)

Sasa's mesh was built to kill **hallucination** (one brain + 85 tools guessing wrong).
**Jensen does not hallucinate.** The transcript proves his real wounds are:

1. **Latency** — median **10.7s/turn**, p90 **21.6s**, felt on *every* turn. He always delivers, just slowly.
2. **Memory, especially around links** — links saved to the wrong meeting, saved at the wrong time, claimed-saved-but-null, lost entirely, or duplicated into 3 rows.

So we take Sasa's primitives but re-justify each against Jensen's actual problem.
Every Sasa primitive maps cleanly onto a Jensen wound:

| Sasa primitive | Jensen wound it fixes | Why |
|---|---|---|
| Deterministic router → scoped specialists (~15 tools, Haiku for reads) | **Latency** | 65 tools → ~15/turn; cheap reads on Haiku; fewer round-trips. NOT for hallucination. |
| One shared execution engine (`runSasa` + `allowedToolNames`) | Maintainability | Reuse the battle-tested loop + honesty guards; don't reimplement per specialist. |
| `pending_intents` (subscription / park-until-event) | **Link arrives before its event → lost** | Park the link, attach when the event appears. |
| Action/provenance spine + non-self-gatable confirm | **"(could not confirm)" tic, silent-drop lies, self-gatable destructive** | Read-back-before-claim. Already ADR-0002. |
| One tool layer, multiple consumers (MCP bridge) | **No desk surface** | Reuse the same tools from ChatGPT + claude.ai, not just WhatsApp. |
| Observability events + leakage guard | Debuggability | "Why did it route there / save there?" answerable from events. |

## What we deliberately do NOT port (protect Jensen's strengths)

- **Sasa's multi-tenant confidentiality walls** — Jensen is single-principal (Law 9). Skip.
- **Sasa's "no monolith fallback" brittleness** — Jensen's prized trait is *always delivers*.
  A specialist miss must **degrade to a broad general handler**, never hard-error. Better-not-worse.
- **Sasa's aggressive PII-scrub-everything** — keep Jensen's existing brand-guard sanitize; don't over-restrict the single owner.

---

## Phase 0 — Latency quick wins (Tier 3, ship first, near-zero risk)

The biggest felt pain, the cheapest fix, no architecture change.

1. **Adaptive `SETTLE_MS`** — `lib/whatsapp-coalesce.ts:33` is a flat 7000ms sleep before the
   model is even called. It alone is ~7s of the ~11s median. Make it adaptive: fire **immediately**
   for a single message; only debounce when a real burst is in flight (2nd inbound within window).
2. **Stream / fast-ack** — `lib/concierge/loop.ts` builds the whole reply before sending one char.
   Either stream tokens, or send a fast "on it" then the result. Perceived latency collapses.

Expected: median turn 10.7s → ~3-4s for the common single-message case.

---

## Phase 1 — The link/memory convergence fix (Tier 1, the data-integrity wound)

The only wound that **loses data**. Fix at the single convergence node, all three breaks together.
Convergence node: `app/api/whatsapp/route.ts:389-471` + `lib/concierge/ops.ts:createEvent` (186-206) + `lib/digital-u.ts:12` (`MEET_RE`).

1. **Link-first capture (drop the platform allowlist gate).** Capture *any* URL the instant it
   arrives; classify platform later. `MEET_RE` only knowing Meet/Zoom/Teams is why the Luma link
   (incident C) silently dropped. Never let an unrecognised host fall on the floor.
2. **Find-or-create keyed on meeting IDENTITY, not title+exact-date.** `createEvent` dedup on
   `title+date=eq` minted 3 Sotiris rows + 2 A2 Milk rows on date corrections. Key on
   normalized(title)+person so a corrected time/date **updates the one row**. This also fixes the
   "meeting" → A2 Milk misroute (incident D): resolve to the right meeting identity, not a fuzzy
   any-word substring match.
3. **Park-buffer for early links (Sasa `pending_intents` pattern).** Link sent before its event
   exists (incident B) → store in a pending-link table keyed to the expected meeting; attach when
   the event appears. No more "I'll save the link" then saving nothing.
4. **Read-back-before-claim.** Only say "saved" after re-reading `events.meeting_url` for the right
   row. Parse the time from the link when present and reconcile against the event. Kills the
   "saved in the notes" lie and the "(could not fully confirm)" tic at the source.

Guard: a seam test replaying incidents B/C/D (Luma, early-link, misroute) + a legitimate single-link
save as negative control.

---

## Phase 2 — Action / memory spine (Tier 1) — aligns with ADR-0002

Already specced as ADR-0002 (action-confirm-and-provenance-spine). Build it:

- **`dorje_actions`** append-only: actor, surface, verb, target identity, payload, **verified
  outcome** (delivered/queued/failed), ts, idempotency key. Honesty rail + idempotency read THIS,
  not the in-memory per-turn `runs[]` (Class C4) which is lost on restart.
- **Non-self-gatable confirm** — the confirm token lives server-side in `pending_actions`, not a
  model-supplied `confirm:true` field (closes Class C1, the self-confirm defect).

This is what structurally ends the dishonesty tic — "I sent it / done" becomes a *projection of
verified state*, not an assertion.

---

## Phase 3 — The specialist mesh (Tier 1, the latency + precision elevation)

Port Sasa's router + specialist + shared-engine pattern, tuned single-tenant.

- **Deterministic two-stage router** (mirror `nisria-sr` `router.ts`): regex patterns (Jensen's
  intent verbs are stable from the transcript) + cheap Haiku fallback on ambiguity. Confidence
  gate; low confidence → general handler (NOT an error — protect "always delivers").
- **~6 specialists** sized by real transcript volume:
  | Specialist | Transcript hits | Model | Notes |
  |---|---|---|---|
  | **Calendar** | 78 | Haiku query / Sonnet write | owns the link-memory fix; the priority lane |
  | **Tasks** (Covey) | 46 | Haiku | list / complete / reprioritize |
  | **Docs** | 23 | Sonnet | file / retrieve / draft / sanad review |
  | **Comms/Email** | 13 | Sonnet | triage / draft / send |
  | **Memory/General** | 44 chat + 4 | Haiku | recall / remember / fallback |
  | **Finance** | 3 | Sonnet | low volume, keep gated |
- **One shared engine**: refactor `runConcierge` → `runJensen({allowedToolNames, domainFocus})`,
  mirroring `runSasa`. Reuse the honesty guards, send chokepoint, hard walls. Specialist passes a
  scoped tool subset (~15) → cuts per-turn tokens ~4x and round-trips.
- **Observability**: emit `jensen.routed {domain, confidence}` / `jensen.completed` / leakage guard.
- **Reliability invariant**: a specialist throw or low-confidence route degrades to the broad
  general handler, never a hard error. Regression net green before/during/after.

---

## Phase 4 — One tool layer, multiple consumers + the ChatGPT custom connector (Tier 1)

Extract the tool layer to a transport-agnostic registry consumed by:
1. **In-process bot** (today).
2. **ChatGPT custom GPT (PRIMARY ask)** — a hosted OpenAPI "Actions" endpoint (`/api/actions/*`)
   with auth (single-tenant → signed bearer / lightweight OAuth like Sasa's bridge).
   `OPENAI_API_KEY` is already in `.env.prod` — auth groundwork exists.
3. *(Optional, later)* **claude.ai MCP bridge** — same shape Sasa already shipped (KT #397/#398).

**Connector capability priority (from the transcript — desk surface = read + compose + reason):**
1. Covey board read (46 hits — far better full-screen than chunked WhatsApp bubbles)
2. Calendar query + create/move (78 hits — the core job)
3. Document / contract drafting (latent demand — painful to type on a phone)
4. Email triage + compose
5. Memory / recall lookup

Lower priority for the connector: reminders/pings (inherently push-to-phone), finance (barely used).

**Caveat:** the same 6-iteration loop + 62-tool payload will be the connector's latency story too —
Phase 3 (tool routing) must land before exposing the connector, or it feels as slow as WhatsApp.

---

## Recommended sequence

`Phase 0 (latency quick wins)` → `Phase 1 (link/memory fix)` → `Phase 2 (spine, ADR-0002)` →
`Phase 3 (specialist mesh)` → `Phase 4 (ChatGPT connector)`.

Rationale: 0+1 are the felt pains, low-risk, fast. 2 is the honesty foundation. 3 is the big
elevation (latency + precision) and the prerequisite for a non-slow connector. 4 is the new surface.
