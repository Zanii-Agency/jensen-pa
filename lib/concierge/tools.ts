// Anthropic tool definitions for Rencontre. Every portal function is operable.
// READ tools run freely; WRITE tools mutate Supabase; SEND tools are gated.
// Keep descriptions tight (they ship in every request; cached).

type Tool = { name: string; description: string; input_schema: any };
const obj = (properties: any, required: string[] = []) => ({ type: "object", properties, required });
const str = (d: string) => ({ type: "string", description: d });
const num = (d: string) => ({ type: "number", description: d });
const bool = (d: string) => ({ type: "boolean", description: d });

export const TOOLS: Tool[] = [
  // ---- Portfolio ----
  { name: "list_entities", description: "List venues, clients, or events.", input_schema: obj({ kind: { type: "string", enum: ["venue", "client", "event"] }, status: str("filter by status text") }) },
  { name: "find_entity", description: "Find a venue/client/event by name.", input_schema: obj({ name: str("name to search") }, ["name"]) },
  { name: "create_entity", description: "Create a venue, client, or event.", input_schema: obj({ kind: { type: "string", enum: ["venue", "client", "event"] }, name: str("name"), subtitle: str("one-line subtitle"), status: str("status"), notes: str("notes") }, ["kind", "name"]) },
  { name: "update_entity", description: "Update a venue/client/event.", input_schema: obj({ id: str("entity id"), name: str(""), subtitle: str(""), status: str(""), notes: str("") }, ["id"]) },
  { name: "delete_entity", description: "Delete a venue/client/event. DESTRUCTIVE: ask the user to confirm in conversation first, then call again with confirm:true.", input_schema: obj({ id: str("entity id"), confirm: bool("must be true; only set after user explicitly confirms the deletion") }, ["id"]) },

  // ---- Tasks ----
  { name: "list_tasks", description: "List tasks. Quadrant 1=urgent+important,2=important,3=urgent-only,4=noise. CRITICAL: the 'done' filter defaults to no filter (all states). If you query done=false and get empty, that ONLY means 'no open tasks matched'; it does NOT mean the task doesn't exist. Before claiming a task 'isn't in the system' or 'doesn't exist', re-query without the done filter to confirm absence.", input_schema: obj({ quadrant: num("1-4"), entityId: str(""), done: bool("") }) },
  { name: "create_task", description: "Add a task to the Covey board. DERIVE QUADRANT from what Jensen says: 'urgent' / 'ASAP' / 'today' / 'deadline' / 'time sensitive' = Q1 (1). 'Important' / 'when you get a chance' / 'protect' / 'this week' = Q2 (2). 'Quick favor' / 'can you handle this' / 'delegate' = Q3 (3). 'FYI' / 'just so you know' / 'don't worry about it' = Q4 (4). Default to Q2 if unclear.", input_schema: obj({ title: str("task"), quadrant: num("1-4: Q1=urgent+important, Q2=important, Q3=urgent-only, Q4=noise. Derive from how Jensen describes it."), entityId: str("link to entity"), due: str("YYYY-MM-DD") }, ["title"]) },
  { name: "update_task", description: "Update a task (title/quadrant/due/done).", input_schema: obj({ id: str(""), title: str(""), quadrant: num(""), due: str(""), done: bool("") }, ["id"]) },
  { name: "send_task_to_peer", description: "Send a task to Taona's own assistant bot. Use ONLY when Jensen EXPLICITLY tells you to send/assign/forward/delegate a task TO TAONA (e.g. 'send this to Taona', 'assign Taona', 'put this on Taona's list', 'forward that to Taona'). NEVER use it just because a task mentions Taona's name: 'meeting with Taona' or 'review the contract with Taona' is NOT a send, do not call this for those. Only the task title and due date reach Taona, nothing else. Also saves the task on Jensen's own board.", input_schema: obj({ title: str("the task text to send to Taona"), due: str("YYYY-MM-DD if Jensen gave a due date, else omit") }, ["title"]) },
  { name: "complete_task", description: "Mark a task done.", input_schema: obj({ id: str("") }, ["id"]) },
  { name: "delete_task", description: "Delete a task. DESTRUCTIVE: ask the user to confirm in conversation first, then call again with confirm:true. Never combine with create_task in one turn from a compound 'add X and delete Y' command.", input_schema: obj({ id: str(""), confirm: bool("must be true; only set after user explicitly confirms the deletion") }, ["id"]) },

  // ---- Calendar ----
  { name: "query_calendar", description: "List events in a date range (YYYY-MM-DD).", input_schema: obj({ from: str(""), to: str(""), entityId: str("") }) },
  { name: "day_log", description: "Get the COMPLETE record of what actually happened on one specific date in Dubai time: Jensen's messages, your replies, the calendar events, and tasks created that day. ALWAYS use this when asked what happened, what came in, or what was handled on a day (today, yesterday, or any named date). Report only what it returns; never summarize a day from memory. date is YYYY-MM-DD.", input_schema: obj({ date: str("the day to look up, YYYY-MM-DD") }, ["date"]) },
  { name: "create_event", description: "Add a calendar event. Use recurrence for repeating events: 'weekly' (every week same day/time), 'monthly' (same day each month), 'yearly' (same date each year). Set recurrenceUntil to stop after a certain date. If Jensen's message includes a meeting join link (Zoom/Teams/Meet), pass it as meetingUrl so it rides every reminder; it is also auto-captured from his message as a backstop.", input_schema: obj({ title: str(""), date: str("YYYY-MM-DD"), time: str("HH:MM"), entityId: str(""), note: str(""), recurrence: str("'weekly', 'monthly', 'yearly', or omit for one-off"), recurrenceUntil: str("YYYY-MM-DD last occurrence date"), meetingUrl: str("meeting join link (Zoom/Teams/Meet) if present") }, ["title", "date"]) },
  { name: "update_event", description: "Update an event. Set recurrence=null to make a recurring event stop recurring. Pass meetingUrl to attach or replace the meeting join link.", input_schema: obj({ id: str(""), title: str(""), date: str(""), time: str(""), note: str(""), recurrence: str("'weekly', 'monthly', 'yearly', or null"), recurrenceUntil: str("YYYY-MM-DD"), meetingUrl: str("meeting join link (Zoom/Teams/Meet)") }, ["id"]) },
  { name: "delete_event", description: "Delete an event. DESTRUCTIVE: ask the user to confirm in conversation first, then call again with confirm:true.", input_schema: obj({ id: str(""), confirm: bool("must be true; only set after user explicitly confirms") }, ["id"]) },
  { name: "accept_meeting_tasks", description: "Accept (or skip) the action items a finished meeting PROPOSED but has not yet added to the board. After Digital Jensen wraps a meeting it sends Jensen a numbered proposal and parks the tasks; they are NOT on his board yet. Call this ONLY when such a proposal is pending and Jensen tells you what to do with it: set numbers to the 1-based items he picked (e.g. [1,3]), omit numbers (or leave empty) when he says 'add all' / 'yes' / 'accept', or set skip=true when he says 'skip' / 'no' / 'drop them'. NEVER recreate these via create_task; they are created deterministically from the stored proposal here.", input_schema: obj({ numbers: { type: "array", items: { type: "number" }, description: "1-based item numbers Jensen chose; omit/empty = add all" }, skip: bool("true if Jensen declined the proposed tasks") }) },
  { name: "complete_event", description: "Mark a calendar event (meeting, visit, call, payment-event) as completed. SAFE: stamps outcome='happened' on the events row and appends a one-line marker to note. Use when Jensen reports a meeting actually happened: 'meeting with Taona is done', 'Sara done', 'Toana done', 'I met Bashir'. THIS IS FOR CALENDAR EVENTS, not to-do TASKS — for tasks use complete_task. Look up the event id first via query_calendar.", input_schema: obj({ id: str("the events.id of the calendar event"), note: str("optional one-line note on how it went") }, ["id"]) },

  // ---- Finance (UAE) ----
  { name: "finance_summary", description: "Income, expense, net. Optionally per entity or period.", input_schema: obj({ entityId: str(""), from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD") }) },
  { name: "list_finance", description: "List finance records.", input_schema: obj({ entityId: str(""), kind: { type: "string", enum: ["income", "expense"] } }) },
  { name: "record_finance", description: "Record an income or expense (AED, net).", input_schema: obj({ kind: { type: "string", enum: ["income", "expense"] }, amount: num("net AED"), vatApplies: bool("does 5% VAT apply"), label: str(""), date: str("YYYY-MM-DD"), entityId: str("") }, ["kind", "amount", "label"]) },
  { name: "update_finance", description: "Update a finance record.", input_schema: obj({ id: str(""), amount: num(""), label: str(""), vatApplies: bool(""), date: str("") }, ["id"]) },
  { name: "delete_finance", description: "Delete a finance record. DESTRUCTIVE + money-moving: ask the user to confirm in conversation first, then call again with confirm:true.", input_schema: obj({ id: str(""), confirm: bool("must be true; only set after user explicitly confirms") }, ["id"]) },
  { name: "vat_report", description: "UAE VAT (5%) output tax due for a period.", input_schema: obj({ from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD") }) },
  { name: "ct_estimate", description: "UAE corporate tax (9% over AED 375k) estimate from net profit.", input_schema: obj({ from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD") }) },

  // ---- Documents / brain ----
  { name: "search_documents", description: "Semantic+keyword search of filed documents. Returns the TEXT/contents so you can read or answer ABOUT a document. Use this to answer questions about a doc.", input_schema: obj({ query: str(""), folder: str(""), entityId: str("") }, ["query"]) },
  { name: "send_filed_document", description: "Send Jensen the ACTUAL FILE (the real PDF/image) of a previously filed document, back to him on WhatsApp. Use this when he asks to 'pull up', 'send me', 'get me', or 'show me' a document itself (e.g. 'send me my passport', 'pull up the Sohum contract'). This delivers the file, not just its text. Only works for files uploaded after they were vaulted.", input_schema: obj({ query: str("what document to send, e.g. 'passport' or 'Sohum agreement'") }, ["query"]) },
  { name: "list_documents", description: "List filed documents by folder/entity.", input_schema: obj({ folder: str("finance|legal|identity|contracts|clients|venues|events|menus|branding|reports|general"), entityId: str("") }) },
  { name: "file_document", description: "Move/assign a document to a folder and entity.", input_schema: obj({ id: str(""), folder: str(""), entityId: str(""), sensitivity: { type: "string", enum: ["normal", "restricted"] } }, ["id", "folder"]) },
  { name: "delete_document", description: "Delete a filed document. DESTRUCTIVE: ask the user to confirm in conversation first, then call again with confirm:true.", input_schema: obj({ id: str(""), confirm: bool("must be true; only set after user explicitly confirms") }, ["id"]) },

  // ---- Generation ----
  { name: "generate_document", description: "Draft a branded business document (proposal/SOP/menu/cost model/report/letter).", input_schema: obj({ type: { type: "string", enum: ["proposal", "sop", "menu", "cost_model", "report", "letter"] }, brief: str("what it should contain"), entityId: str("") }, ["type", "brief"]) },
  { name: "generate_legal", description: "Draft a legal document grounded on Jensen's legal blueprint.", input_schema: obj({ type: { type: "string", enum: ["nda", "service", "consultancy", "engagement", "letter"] }, brief: str("parties, scope, terms") }, ["type", "brief"]) },
  { name: "set_legal_blueprint", description: "Save/replace Jensen's standing legal blueprint.", input_schema: obj({ text: str("") }, ["text"]) },

  // ---- Contacts ----
  { name: "list_contacts", description: "List contacts.", input_schema: obj({}) },
  { name: "find_contact", description: "Find a contact by name or company.", input_schema: obj({ query: str("") }, ["query"]) },
  { name: "add_contact", description: "Add a contact.", input_schema: obj({ name: str(""), company: str(""), role: str(""), email: str(""), phone: str(""), entityId: str("") }, ["name"]) },
  { name: "update_contact", description: "Update a contact.", input_schema: obj({ id: str(""), name: str(""), company: str(""), role: str(""), email: str(""), phone: str("") }, ["id"]) },
  { name: "delete_contact", description: "Delete a contact. DESTRUCTIVE: ask the user to confirm in conversation first, then call again with confirm:true.", input_schema: obj({ id: str(""), confirm: bool("must be true; only set after user explicitly confirms") }, ["id"]) },

  // ---- Entity intelligence ----
  { name: "entity_dashboard", description: "Full view of everything about one venue, client, or event: tasks, events, finance records, notes, contacts. Use when Jensen asks 'what is going on with X' or wants a per-entity overview.", input_schema: obj({ entityId: str("entity id from list_entities"), name: str("entity name if you don't have the id") }, []) },

  // ---- Notes ----
  { name: "list_notes", description: "List notes/ideas/links/journal.", input_schema: obj({ kind: { type: "string", enum: ["note", "idea", "link", "journal"] } }) },
  { name: "add_note", description: "Capture a note, idea, link, or journal entry.", input_schema: obj({ kind: { type: "string", enum: ["note", "idea", "link", "journal"] }, title: str(""), body: str(""), url: str(""), entityId: str("") }, ["body"]) },
  { name: "delete_note", description: "Delete a note. DESTRUCTIVE: ask the user to confirm in conversation first, then call again with confirm:true.", input_schema: obj({ id: str(""), confirm: bool("must be true; only set after user explicitly confirms") }, ["id"]) },

  // ---- Mail (read freely; SEND only after confirming wording with Jensen) ----
  { name: "list_inbox", description: "List Jensen's latest emails across ALL his connected mailboxes (Outlook, Zoho, larencontre), each with an id, sender, subject, date, snippet.", input_schema: obj({ limit: num("how many, default 10") }) },
  { name: "read_email", description: "Read the full text of one email by its id (ids come from list_inbox).", input_schema: obj({ id: str("email id from list_inbox") }, ["id"]) },
  { name: "search_email", description: "Search Jensen's previously-surfaced emails by sender name, email address, or subject. Use this when Jensen says 'it must be in my email' and list_inbox returns nothing — the email may have been processed earlier and is no longer in the live inbox. Searches both the triage cache and prior chat messages.", input_schema: obj({ sender: str("sender name or email to search for"), subject: str("optional subject keywords"), limit: num("max results, default 5") }) },
  { name: "reply_email", description: "Send a reply to an email by its id. DESTRUCTIVE: this SENDS the email immediately from the right mailbox. Show Jensen the exact draft body first, ask him to confirm, then call again with confirm:true.", input_schema: obj({ id: str("email id from list_inbox"), body: str("the reply message to send"), confirm: bool("must be true; only set after user confirms the exact wording") }, ["id", "body"]) },
  { name: "draft_reply", description: "Draft (NOT send) an email reply for Jensen to review.", input_schema: obj({ to: str(""), subject: str(""), intent: str("what to say") }, ["intent"]) },
  { name: "send_email", description: "Compose and SEND a brand-new email from Jensen's own mailbox to any address. This is for a NEW email to someone (use reply_email only to reply to a message already in his inbox). DESTRUCTIVE + outbound: it SENDS a real email. Show Jensen the exact recipient, subject and body first, get his explicit confirmation, then call again with confirm:true.", input_schema: obj({ to: str("recipient email address"), subject: str("subject line"), body: str("the full email body to send"), confirm: bool("must be true; only after Jensen confirms the exact wording") }, ["to", "subject", "body"]) },
  { name: "send_meeting_invite", description: "Send a REAL calendar meeting invite (accept/decline) from Jensen's own mailbox to an external guest, AND put it on his calendar + board. Times are Dubai. DESTRUCTIVE + outbound: it SENDS an invite to a real person. First echo the resolved date, time (Dubai), attendee and location back to Jensen and get explicit confirmation, THEN call again with confirm:true.", input_schema: obj({ title: str("meeting subject"), date: str("YYYY-MM-DD"), time: str("HH:MM 24h, Dubai time"), durationMin: num("length in minutes, default 60"), attendeeEmail: str("the recipient's email"), attendeeName: str("recipient name, optional"), location: str("location, optional"), note: str("agenda/body, optional"), confirm: bool("must be true; only after Jensen confirms the exact details") }, ["title", "date", "time", "attendeeEmail"]) },

  // ---- Voice call (telephony) ----
  { name: "call_owner", description: "Place a phone call to Jensen that speaks a short message aloud. DESTRUCTIVE: this rings his actual phone. Only when he explicitly asks to be called or for a true urgent reminder. Confirm the message wording first, then call with confirm:true.", input_schema: obj({ message: str("one or two sentences to speak on the call"), confirm: bool("must be true; only set after user confirms") }, ["message"]) },

  // ---- Memory / brain ----
  { name: "remember_fact", description: "Store a durable fact about Jensen's world for long-term memory.", input_schema: obj({ fact: str(""), subject: str("who/what it is about") }, ["fact"]) },
  { name: "remember_preference", description: "Save a STANDING INSTRUCTION or shorthand to always honor from now on (e.g. 'always reply short', 'ddjt = dont do just talk, plan first'). Use whenever Jensen says 'remember', 'from now on', or teaches you a rule or term.", input_schema: obj({ instruction: str("the rule, preference, or shorthand to always follow") }, ["instruction"]) },
  { name: "query_memory", description: "Recall what you know about a person, venue, client, or topic.", input_schema: obj({ about: str("") }, ["about"]) },
  { name: "list_memory", description: "List everything you remember (facts + standing instructions) so Jensen can review it.", input_schema: obj({}) },
  { name: "forget_memory", description: "Forget a remembered item by its id (ids come from list_memory). DESTRUCTIVE: ask the user to confirm in conversation first, then call again with confirm:true.", input_schema: obj({ id: num("memory id"), confirm: bool("must be true; only set after user explicitly confirms") }, ["id"]) },

  // ---- Admin only (Taona, development) ----
  { name: "read_owner_chats", description: "ADMIN ONLY. Read Jensen's recent conversations with the concierge, for development and oversight.", input_schema: obj({ limit: num("how many recent messages, default 40") }) },

  // ---- Brief / proactive ----
  { name: "morning_brief", description: "Compose the cleared-board brief: what's done, what's queued (Q1), what's protected (Q2). Uses Dubai time.", input_schema: obj({}) },

  // ---- Settings / goals ----
  { name: "get_settings", description: "Read Jensen's preferences and goals.", input_schema: obj({}) },
  { name: "update_prefs", description: "Update working preferences (style/tone/hours), and the onboarding gate. Admin only: set onboarding=false to ACTIVATE the bot for Jensen (end listen-only onboarding); onboarding=true returns him to onboarding.", input_schema: obj({ workStyle: str(""), tone: str(""), hours: str(""), extra: str(""), onboarding: bool("false = activate bot for Jensen; true = listen-only onboarding") }) },
  { name: "set_goals", description: "Set Jensen's goals list.", input_schema: obj({ goals: { type: "array", items: { type: "string" } } }, ["goals"]) },

  // ---- Store ----
  { name: "store_summary", description: "Live Shopify store data: order count, revenue, and recent orders with customer, items, fulfillment status and tracking. Use for any question about orders, sales, revenue, customers, or deliveries.", input_schema: obj({}) },

  // ---- Sanad (UAE legal brain via Jensen-side API) ----
  // Use these when a contact asks for a FORMAL UAE contract or wants a contract
  // they received reviewed. For quick informal letters keep using generate_legal
  // (which uses Jensen's own blueprint). Sanad is slower (~2 min) but cites the
  // exact UAE article and produces a courtroom-format PDF.
  {
    name: "sanad_draft_contract",
    description: "Draft a formal UAE contract via Sanad. ASYNC: returns a job_id and an avg 2-minute wait. The delivery cron sends the PDF to the user automatically when ready. Use for NDAs, services agreements, contractor agreements, founders agreements, SAFE, term sheets, MOHRE annexes, DIFC/ADGM employment, IP licences, MOUs.",
    input_schema: obj({
      kind: { type: "string", enum: ["nda", "services_agreement", "msa", "sow", "contractor_agreement", "consultancy_agreement", "engagement_letter", "founder_agreement", "shareholders_agreement", "safe_uae", "term_sheet", "convertible_note", "share_subscription", "esop_plan", "distribution_agreement", "ip_license", "ip_assignment", "mou_loi", "settlement_agreement", "privacy_policy", "dpa", "terms_of_service", "mohre_annex", "difc_employment", "adgm_employment", "ejari_tenancy", "commercial_lease", "termination_letter", "power_of_attorney"] },
      jurisdiction: { type: "string", enum: ["mainland", "difc", "adgm", "free-zone"] },
      party_a_name: str("First party legal name"),
      party_a_details: str("First party details (entity type, jurisdiction of incorporation, address) - optional"),
      party_b_name: str("Second party legal name"),
      party_b_details: str("Second party details - optional"),
      effective_date: str("YYYY-MM-DD - optional, defaults to today"),
      additional_context: str("Extra clauses, fees, scope of work, special terms - optional"),
      recipient_wa: str("WhatsApp E.164 of the user the PDF should be sent to when ready")
    }, ["kind", "jurisdiction", "party_a_name", "party_b_name", "recipient_wa"])
  },
  {
    name: "sanad_review_contract",
    description: "Review a UAE contract text via Sanad. SYNC under 30 seconds. Returns verdict (GREEN/YELLOW/RED), 2-3 sentence summary, top 3 things to flag, red flags with severity, suggested redlines with rationale, and citations from UAE law. Use when a contact pastes a contract.",
    input_schema: obj({
      text: str("Full contract text the user pasted, minimum 200 chars"),
      kind: str("optional contract kind hint, e.g. 'nda', 'services_agreement'"),
      jurisdiction: { type: "string", enum: ["mainland", "difc", "adgm", "free-zone"] }
    }, ["text"])
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
// Tools only the admin (Taona) may use; filtered out for Jensen so the privacy
// wall is one-way (he can never read the admin's side).
export const ADMIN_ONLY = new Set(["read_owner_chats"]);
// Tools whose ok=true is required to back a "done/saved/sent" claim (verifier).
export const COMPLETION_TOOLS = new Set([
  "create_entity", "update_entity", "delete_entity", "create_task", "update_task", "complete_task", "delete_task",
  "create_event", "update_event", "delete_event", "complete_event", "accept_meeting_tasks", "record_finance", "update_finance", "delete_finance",
  // generate_document/generate_legal produce DRAFT TEXT only (no file saved, no
  // delivery), so they must NOT back a "filed/generated your document" claim.
  // Keeping them out of COMPLETION_TOOLS lets the honesty rail rewrite any such
  // claim to the truth. file_document (a real save) stays.
  "file_document", "delete_document", "set_legal_blueprint",
  "send_task_to_peer",
  "add_contact", "update_contact", "delete_contact", "add_note", "delete_note", "remember_fact",
  "remember_preference", "forget_memory", "update_prefs", "set_goals", "reply_email",
]);
