// @zanii/brain-core — public API.
//
// Empty machinery for sinanagency bots. Each Adapter brings its own
// persona text, tool implementations, DB connection, and audience rules.
// The package itself ships zero tenant-specific knowledge.
//
// v0.1 surface: prompt cache split primitive (the first piece extracted
// from Sasa's runSasa, arch2 c8e510f). Subsequent versions add the
// Anthropic client wrapper, tool dispatch loop, and honesty guards.
export { splitForCache } from "./prompt-cache.js";
export { runClaude } from "./claude-client.js";
export { isAmbiguousReference, isCapabilityQuestion, isHedge, isHedgeLoop } from "./intent-detect.js";
export { makeCompletionGuard, makeSendGuard, makeStagingGuard, makeSympathyGuard } from "./honesty-guards.js";
// v0.6 (2026-06-16): schema-drift detector. See schema-guard.ts header for
// the 2026-06-15 Sasa cascade that motivated this.
export { checkSchema, formatSchemaResult } from "./schema-guard.js";
// v0.7 (2026-06-16): cross-bot tool registry. discriminatorMismatch lifted
// from Sasa (smart-tools.ts) and Jensen (concierge/dispatch.ts) as the first
// proof of the adapter pattern. See tool-registry.ts + discriminator.ts.
export { discriminatorMismatch } from "./discriminator.js";
export { register, list, get, _resetForTest } from "./tool-registry.js";
// v0.8 (2026-06-16): webhook dedup + media-pending buffer. Cross-bot guard
// against Meta duplicate webhooks and split image+text deliveries.
// Lifted from Jensen's route.ts. See webhook-guard.ts header for KT #302.
export { shouldProcess, mediaArrived, _resetForTest as _resetWebhookGuard } from "./webhook-guard.js";
// v0.9 (2026-06-17): send chokepoint with audit logging. Unified primitive
// for Law 2 — every outbound message passes through a single door where
// sanitization, dev-routing, and audit logging happen. Adapter provides
// persistence shape, dev phone, and send function.
export { sendWithAudit } from "./send-chokepoint.js";
//# sourceMappingURL=index.js.map