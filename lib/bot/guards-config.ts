// Jensen PA's BotGuardsConfig — v0.2 (defineBotConfig: frozen, precompiled).
//
// CRITICAL CONTEXT: Jensen ACTUALLY uses the Eisenhower four-quadrant framework
// in his consultancy work. So "4Q" / "four quadrant" are LEGITIMATE in Jensen's
// output and MUST NOT be in his bannedPatterns or forbiddenBrands. The
// historical contamination incident was when 4Q leaked FROM Jensen TO Sasa
// (where it appeared as a fictional "Stephen" inventor). Sasa's config bans
// 4Q + Stephen for that reason; Jensen's allows them. Per-bot configuration
// is the wall — and as of 2026-06-12 this config is enforced INSIDE
// sendWhatsApp (the primitive), so the morning brief, every webhook reply,
// and every cron push pass it with no bypassable wrapper.

import { defineBotConfig } from '../bot-guards/index.js'

export const JENSEN_BOT_GUARDS_CONFIG = defineBotConfig({
  botName: "Jensen's Concierge",

  // Class A client-leakage wall (KT #328). Every entry below fires ONLY on a
  // bot self-leak (a bug), never on normal client copy, so `drop` (kill the
  // reply, swap in reaskPhrase, log a pre_send_caught alert for the operator)
  // is the safe failure, not a hot-path cost. These close the uncovered
  // transcript failures: infra narration to the client ("API tokens drained,
  // Taona caught it"), a literal "test" artifact + its recant, and a plaintext
  // "Password: ..." over WhatsApp. Law 5 (dashes) stays upstream in stripDashes.
  bannedPatterns: [
    // Credentials must never traverse the client channel (Law 3).
    // NARROWED 2026-09-22. This fired three times in production and every fire was
    // a FALSE DROP of a real meeting invite: two Teams invites ("Passcode: ...",
    // 09-Jul + 14-Jul) and a Zoom join link six minutes before the call
    // ("?pwd=..." in the URL, 08-Sep, "Reminder. Zoom with Wessam at 15:30").
    // Every Zoom URL carries pwd=, so Jensen could not receive a Zoom link at all.
    // 'passcode' is the MEETING word and is dropped from the alternation; the
    // lookbehind exempts a pwd that is a URL query parameter. The Jun-18 incident
    // this guard exists for said "Password: ..." and is still covered.
    { label: 'plaintext_credential', mode: 'drop', pattern: /(?<![?&])\b(password|pwd)\b\s*[:=]\s*\S+/i },
    { label: 'login_credential', mode: 'drop', pattern: /\blogin\b\s*[:=]\s*\S+/i },
    // Internal/infra narration must never reach the client (Law 1 persona).
    { label: 'infra_api_token', mode: 'drop', pattern: /\bapi[\s-]?(key|token)s?\b/i },
    { label: 'infra_tokens_drained', mode: 'drop', pattern: /\btokens?\b[^.]{0,40}\bdrained\b/i },
    { label: 'infra_system_logs', mode: 'drop', pattern: /\bsystem logs?\b/i },
    { label: 'infra_code_bug', mode: 'drop', pattern: /\bcode bug\b/i },
    // Test/dev artifacts must never land on the owner's phone (Law 10).
    { label: 'test_artifact_only', mode: 'drop', pattern: /^\s*test\s*$/i },
    { label: 'test_recant', mode: 'drop', pattern: /\btest\b[^.]{0,40}\bnot actually sent\b/i },
    // Developer/persona leak (KT #340). 'Taona' WAS a bare forbiddenBrand, but it
    // collided with Jensen's OWN board ("Dorje contract for Taona", "Meeting with
    // Taona") and silently dropped EVERY list request — same failure class as
    // 'Stephen' (KT #339): a name that is also legitimate client data cannot be a
    // blanket drop. Scope it to dev/infra ACTION context instead, so the Jun-18
    // persona leak ("Taona caught it, recharged the tokens") still dies while
    // Jensen's legitimate references to Taona flow. Verified board-passes /
    // leak-drops in seam.61.
    { label: 'dev_persona_leak', mode: 'drop', pattern: /\btaona\b[^.!?\n]{0,50}\b(caught|recharged|topped\s*up|drained|deployed|debugg\w*|restarted|the bug|a bug|code bug|api|token|server|backend|fixed it|fixed the|caught it|built|created|made|runs?|operates?|maintains?|developed|designed|coded|set\s*up|wrote|programm\w*)\b|\b(caught|recharged|topped\s*up|drained|deployed|debugg\w*|restarted|fixed it|fixed the|caught it|built|created|made|runs?|operates?|maintains?|developed|designed|coded|set\s*up|wrote|programm\w*)\b[^.!?\n]{0,50}\btaona\b/i },
    // Agency-brand provenance leak (KT #341). 'zanii' WAS a bare forbiddenBrand and
    // collided with Jensen's OWN board ("Update payment link for Zanii") exactly the
    // way 'Stephen' (#339) and 'Taona' (#340) did: a token that is ALSO legitimate
    // client data cannot be a blanket drop. What Law 9 protects is PROVENANCE — the
    // bot revealing whose product it is, or cross-selling a sibling — not the name of
    // a vendor Jensen pays. Scoped to product-suite + attribution framing so his own
    // references flow. `persona_self_disclosure` below already covers "<X> built/runs
    // me" name-independently, so this does not need loose verb proximity.
    // NARROWED 2026-09-22 after reading Jensen's actual traffic: his inbox carries
    // a Meta thread about "showcasing the Zanii Ledger" at a Tech Council event he
    // is involved in, and his board carries "Update payment link for Zanii". Zanii
    // is a counterparty and a topic he already knows, so product names and the
    // domain are CLIENT DATA here, not a leak. Only self-attribution is a Law 9
    // breach, and `persona_self_disclosure` below already covers the name-free
    // shapes ("<X> built/runs me").
    { label: 'agency_brand_leak', mode: 'drop', pattern: /\b(powered|built|made|created|developed|designed|operated|maintained|run|hosted|licensed|supplied)\s+(by|through|on)\s+(the\s+)?zanii\b|\b(i am|i'm|we are|we're|this is)\s+(an?\s+)?zanii\b|\b(a|an|this)\s+zanii\s+(product|tool|service|platform|assistant|agent|bot)\b/i },
    // Self-referential persona break (KT #340): the real secret is not the NAME
    // "Taona" (Jensen knows him, has "Meeting with Taona" on his calendar) — it is
    // the bot ADMITTING a human built or runs it. This catches "<verb> me / this
    // bot" and "my developer/operator", name-independent, and never touches a task
    // title like "contract for Taona" (no self-reference). Backstops the upstream
    // persona rule in loop.ts which is primary but fallible (the Jun-18 leak proved it).
    { label: 'persona_self_disclosure', mode: 'drop', pattern: /\b(built|made|wrote|created|set\s*up|runs?|operates?|maintains?|developed|coded|programm\w*|designed)\b[^.!?\n]{0,20}\b(me|this (assistant|bot|system|tool|service|concierge|partner))\b|\bmy (developer|operator|builder|engineer|coder|programmer|creator|maker)\b/i },
  ],

  // Brand names + the developer's name that MUST NEVER appear in Jensen's
  // output. Any match drops the whole reply (contamination event).
  forbiddenBrands: [
    'Sasa',
    'Nisria',
    'Maisha',
    'AHADI',
    'Cape Town Halaal',
    'Young at Heart Festival',
    // 'Stephen' removed (KT #339): a Sasa-only fictional-persona guard that collided
    // with Jensen's REAL contact "Stephen Sutherland", dropping legit replies. Sasa keeps it.
    'Canada Made',
    'Sinan Agency',
    'sinanagency',
    // 'Taona' removed (KT #340): bare-string ban dropped Jensen's OWN board, which
    // legitimately contains "Dorje contract for Taona" + "Meeting with Taona". Moved
    // to the scoped `dev_persona_leak` bannedPattern above (drops dev/infra narration
    // about Taona, passes Jensen's own references). Same lesson as 'Stephen' (KT #339).
    // 'zanii' removed (KT #341): THIRD instance of #339/#340. Jensen's own Q1 board
    // carries "Update payment link for Zanii" (Zanii is a counterparty he pays), so
    // the bare ban dropped EVERY board render — he asked for his list four times on
    // 2026-09-22 and got "Let me get back to you on that in a moment." each time.
    // Moved to the scoped `agency_brand_leak` bannedPattern above. Law 9 protects
    // PROVENANCE (whose product this is), not the string.
    'sanad',             // sibling zanii product — never surfaced to this client
  ],

  intentEnum: [
    'mail_triage',         // "what's in my inbox?", "any reply needed?"
    'mail_draft',          // "draft a reply to X"
    'calendar_query',      // "what do I have on Friday?"
    'calendar_create',     // "schedule a meeting", "block 3 hours"
    'contact_lookup',      // "who is X?", "phone for Y"
    'task_note',           // "remind me about", "note this"
    'consultancy_advice',  // strategy/SOP/menu/cost questions (4Q framework lives here)
    'document_request',    // "draft a PDF for", "create the proposal"
    'open_conversation',   // fallback
  ],

  pendingKinds: ['mail_draft_confirming', 'calendar_clarifying'],

  // What Jensen receives when a reply is killed. It WAS 'Tell me more so I can
  // handle it.', and the scheduled senders (08:00 brief, reminders, mail alerts)
  // delivered it raw: on 17-22 Sep his entire morning brief was that one line, six
  // days running. KT #338 already ruled the cryptic phrase must never reach him;
  // only one of the two send paths honoured it. Fixed at the source so every path
  // does. The full original goes to the developer (sendTextAndLog / sendWhatsApp).
  reaskPhrase: 'Let me get back to you on that in a moment.',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
})
