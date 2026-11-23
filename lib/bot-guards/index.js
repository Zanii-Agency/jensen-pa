// @zanii/bot-guards v0.2 — public API.
//
// Pure machinery, zero bot knowledge. Each function REQUIRES a BotGuardsConfig
// built with defineBotConfig(). v0.2 adds: drop/strip pattern modes, precompiled
// brand regexes, frozen + type branded configs, and createOutbound — the sender
// factory that puts the wall INSIDE the primitive so bypass is impossible.
export { defineBotConfig } from "./config.js";
export { sanitizeReply } from "./pre-send.js";
export { classifyIntent } from "./classifier.js";
export { resolvePendingAction } from "./pending-resolver.js";
export { createOutbound } from "./outbound.js";
//# sourceMappingURL=index.js.map