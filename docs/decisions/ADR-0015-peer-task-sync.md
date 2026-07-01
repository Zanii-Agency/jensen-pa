# ADR-0015 — Cross-bot task sync (Dorje ↔ Taona-bot)

Status: Accepted (2026-07-01). Default-OFF until soaked.

## Context
Jensen and Taona collaborate. When Jensen explicitly tells Dorje to *send a task to Taona*, that task should land on Taona-bot's board + ping Taona on WhatsApp, and status changes should flow back. Both bots are single-tenant with strict PII walls (Law 3) and single-tenant isolation (Law 9). A leaky bridge would breach both.

## Decision
A narrow, fail-closed, HMAC-signed HTTP bridge between the two services, NOT a WhatsApp-between-bots channel and NOT the WhatsApp/`isOwner` inbound path.

1. **Trigger = explicit intent, never a name match.** A task crosses ONLY when Jensen explicitly directs "send/assign/forward to Taona" (the model calls the `send_task_to_peer` tool). A task that merely *mentions* Taona ("meeting with Taona") never crosses. Same law as the discriminator-name wall (KT #293): act on intent, never on a name match.
2. **Field allowlist (the wall).** Only `{title, due, status, correlation_id, source_bot}` serialize. `entity_id`, notes, finance, contacts, guest/PII are never placed in the payload — the mapper builds a fresh object, never spreads the task row.
3. **Dedicated fail-closed endpoint.** `/api/peer/task-sync` on each bot, authed by a shared `PEER_SYNC_SECRET` (HMAC-SHA256, timing-safe, fail-closed when secret/sig absent). Separate from the human/owner path (Taona-bot's `isOwner`/`whoIs` is fail-open by design; the bridge must not touch it).
4. **Default-OFF.** Gated on `PEER_SYNC === "on"`. When off, every bridge call is an inert no-op — zero change to either live bot.
5. **Correlation.** The Dorje-side task id is the `correlation_id`; status-backs match on it. No private data needed to link the two copies.

## Rejected alternatives
- **WhatsApp bot-to-bot:** Meta's 24h window silently drops messages (today's incident) + free-text parsing is un-wallable. Rejected.
- **Shared DB table:** couples the two tenants at the storage layer — the hardest boundary to keep tight. Rejected.
- **Route peer via the WhatsApp `isOwner` gate:** it is fail-open (defaults senders to owner). Would grant a peer owner-level access. Rejected.

## Consequences
- Adds one tool, one lib, one endpoint per bot, all behind a flag.
- Reverse (status-back) requires the peer to POST to `JENSEN_PUBLIC_URL/api/peer/task-sync`.
- Soak with the flag off (inert) confirmed by walls, then on with secrets set.

## Reversibility
Fully reversible: unset `PEER_SYNC` → inert. Remove the tool + endpoint to fully revert.
