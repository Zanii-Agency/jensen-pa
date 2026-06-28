// Mail autopilot. Pulls every connected mailbox, classifies new arrivals with the
// existing triage Haiku, and pushes a WhatsApp proposal to Jensen for every
// fresh email that needs a human reply. Idempotent: tracks seen unified-ids in
// kv so the same email never pings twice. The proposal includes the unified
// email id so when Jensen says "yes / send / lfg" the concierge LLM can dispatch
// reply_email(id, body, confirm:true) without inventing state.
//
// Send chokepoint: every outbound WhatsApp goes through sendTextAndLog (Law 2).
// Send constraint (Law 8 + Taona's "never auto reply"): this module NEVER sends
// mail itself. It only proposes drafts to WhatsApp and marks the email seen.
// The actual send happens later through the existing reply_email tool, which
// already gates on confirm:true.

import { aggregateInbox, readUnified, type UMailSummary } from "@/lib/mail-provider";
import { triageInbox, type TriagedMail } from "@/lib/mail-triage";
import { rememberEmail } from "@/lib/concierge/brain";
import { sendTextAndLog } from "@/lib/sendTextAndLog";
import { kvGet, kvSet } from "@/lib/db";
import { whoIs } from "@/lib/whatsapp";
import { isInWindow } from "@/lib/whatsapp-window";
import { enqueue, drain, peekCount, type PendingProposal } from "@/lib/mail-pending";
import { dispatchMeetingBot } from "@/lib/digital-u";

const SEEN_KEY = "lr_mail_seen";
const SEEN_CAP = 500;

// Sender patterns we never propose drafts for, even if triage says needsReply.
// These are first-line defence against noise; triage's needsReply flag is the
// second line. A sender is filtered if ANY pattern matches.
const NOISE_PATTERNS: RegExp[] = [
  /\bno-?reply\b/i,
  /\bdonotreply\b/i,
  /\bjobalerts?-noreply\b/i,
  /@linkedin\.com$/i,
  /@.*facebookmail\.com$/i,
  /@.*instagram\.com$/i,
  /@.*googleplay-noreply/i,
  /@marketing\./i,
  /@notifications?\./i,
  /@email\./i,
  /@event\./i,
  /@editorial\./i,
  /@security\./i,
  /@registration\./i,
  /@drinks-intel\.com$/i,
  /@sevenrooms\.com$/i,
  /@.*gitex\.com$/i,
  /@.*linktr\.ee$/i,
  /@.*virginmobile\.ae$/i,
  /@.*wio\.io$/i,
];

function isNoise(fromEmail: string): boolean {
  const e = (fromEmail || "").toLowerCase();
  if (!e) return true;
  return NOISE_PATTERNS.some((re) => re.test(e));
}

type SeenMap = Record<string, number>;

async function loadSeen(): Promise<SeenMap> {
  return kvGet<SeenMap>(SEEN_KEY, {});
}

async function saveSeen(seen: SeenMap): Promise<void> {
  // FIFO eviction: keep newest SEEN_CAP entries by timestamp.
  const entries = Object.entries(seen);
  if (entries.length > SEEN_CAP) {
    entries.sort((a, b) => b[1] - a[1]);
    seen = Object.fromEntries(entries.slice(0, SEEN_CAP));
  }
  await kvSet(SEEN_KEY, seen);
}

// Build the email body bubble. Shows sender, subject, and actual email text (snippet/bodyPreview).
function buildEmailBody(m: TriagedMail): string {
  const q = m.quadrant === 1 ? "Q1 (urgent, important)"
          : m.quadrant === 2 ? "Q2 (important)"
          : m.quadrant === 3 ? "Q3 (urgent only)"
          : "Q4";
  const fromLine = m.from && m.from !== m.fromEmail ? `${m.from} <${m.fromEmail}>` : (m.fromEmail || m.from);
  const body = m.snippet || m.summary || "(no preview)";
  return [
    "I noticed a new email that needs your eyes.",
    "",
    `From: ${fromLine}`,
    `Subject: ${m.subject}`,
    `Mailbox: ${m.accountEmail}`,
    `Priority: ${q}`,
    "",
    body,
  ].join("\n");
}

// Build the draft reply bubble.
function buildDraft(m: TriagedMail): string {
  return [
    "My draft reply:",
    `"${m.draft.trim()}"`,
    "",
    "Reply 'yes' to send as is, 'change to: ...' to edit, or 'skip' to drop.",
  ].join("\n");
}

// Build the "needs your steer" bubble for an email the bot could NOT ground
// (KT #332). CRITICAL: this is addressed to JENSEN, names the missing info, and
// carries NO "My draft reply" / "yes to send" affordance, so a stray "yes" can
// never fire it at the sender. The bot asks; it never guesses.
function buildSteerAsk(m: TriagedMail): string {
  const gap = (m.steerGap || "some details I do not have on file").trim();
  return [
    "On this one I do not want to guess.",
    `They are asking about ${gap}, and I do not have that on file.`,
    "",
    "Send me the details and I will draft the reply for you, or tell me how you want to handle it.",
  ].join("\n");
}

export type SweepResult = {
  ok: boolean;
  scanned: number;
  newUnseen: number;
  proposed: number;
  filteredNoise: number;
  notNeedingReply: number;
  seeded: boolean;
  windowOpen: boolean;
  queued: number;        // proposals added to off-window queue on this run
  drained: number;       // proposals delivered from a previously-queued backlog
  errors?: string[];
};

// Pick the WhatsApp number to ping. Defaults to first owner (Jensen). When
// JENSEN_MODE=TRAINING, route to the admin number instead so Taona can shake
// the autopilot down without spamming Jensen.
function recipientNumber(): string | null {
  const raw = process.env.OWNER_WHATSAPP || "";
  const nums = raw.split(",").map((n) => n.trim()).filter(Boolean);
  if (nums.length === 0) return null;
  const training = (process.env.JENSEN_MODE || "").trim() === "TRAINING";
  if (training) {
    const admin = nums.find((n) => whoIs(n).role === "admin");
    if (admin) return admin;
  }
  const owner = nums.find((n) => whoIs(n).role === "owner");
  return owner || nums[0];
}

export async function sweepAndPropose(): Promise<SweepResult> {
  const errors: string[] = [];
  let aggregated: UMailSummary[] = [];
  try {
    // perAccount=25 picks up bursts; aggregateInbox already merges across all
    // connected mailboxes and sorts newest-first.
    aggregated = await aggregateInbox(25);
  } catch (e: any) {
    errors.push(`aggregate: ${e?.message || String(e)}`);
    return { ok: false, scanned: 0, newUnseen: 0, proposed: 0, filteredNoise: 0, notNeedingReply: 0, seeded: false, windowOpen: false, queued: 0, drained: 0, errors };
  }

  const seen = await loadSeen();
  const seededFirstRun = Object.keys(seen).length === 0;

  // Mark every fetched id as seen up front so a partial failure mid-loop never
  // re-pings already-handled mail on the next run.
  const now = Date.now();
  const unseen = aggregated.filter((m) => !(m.id in seen));
  for (const m of aggregated) seen[m.id] = now;
  await saveSeen(seen);

  // First run: seed only, don't propose. Otherwise a freshly-deployed cron
  // would dump 50 historical proposals into WhatsApp the first time it fires.
  if (seededFirstRun) {
    return { ok: true, scanned: aggregated.length, newUnseen: unseen.length, proposed: 0, filteredNoise: 0, notNeedingReply: 0, seeded: true, windowOpen: false, queued: 0, drained: 0, errors };
  }

  // 24-hour customer-service window check. If Jensen has not messaged the bot
  // in 24h, free-text sends look successful at the HTTP layer but Meta drops
  // them silently. Cache once per sweep so the per-uid loop can branch on it.
  const win = await isInWindow("jensen");

  // Drop obvious noise BEFORE the triage call so we don't spend Haiku tokens on
  // LinkedIn job alerts and sevenrooms confirmations.
  const candidates = unseen.filter((m) => !isNoise(m.fromEmail));
  const filteredNoise = unseen.length - candidates.length;
  if (candidates.length === 0 && (!win.open || (await peekCount()) === 0)) {
    // Nothing new to triage AND no backlog to drain. Honest empty tick.
    return { ok: true, scanned: aggregated.length, newUnseen: unseen.length, proposed: 0, filteredNoise, notNeedingReply: 0, seeded: false, windowOpen: win.open, queued: 0, drained: 0, errors };
  }

  let triaged: TriagedMail[] = [];
  if (candidates.length > 0) {
    try {
      triaged = await triageInbox(candidates);
    } catch (e: any) {
      errors.push(`triage: ${e?.message || String(e)}`);
    }
  }

  // Post-send reply detection: check if any fresh email is a reply to a recently
  // sent email. If so, flag it for Jensen so he sees the reply conversationally.
  if (candidates.length > 0) {
    try {
      const pending = await kvGet<Record<string, { to: string; subject: string; sentAt: number }>>("lr_sent_pending", {});
      if (Object.keys(pending).length > 0) {
        const freshReplies = triaged.filter((m) => {
          if (!m.needsReply) return false;
          const norm = (m.subject || "").replace(/^(Re|Fwd):\s*/i, "").trim().toLowerCase().slice(0, 80);
          const threadKey = `${m.fromEmail}::${norm}`;
          return !!pending[threadKey];
        });
        for (const r of freshReplies) {
          r.summary = `Reply received: ${r.summary}`;
          r.important = true;
          r.urgent = true;
          r.quadrant = 1;
        }
      }
    } catch {}
  }

  // AUTO-LATCH for meetings. Any triaged email whose event extractor surfaced
  // a meetingUrl + concrete date+time gets scheduled with the meeting-bot
  // (30s before joinAt). Idempotent: the kv "latched" set keeps the same
  // message id from double-firing across sweeps. Date-only events (no time)
  // are skipped because we have no way to know when to join.
  if (triaged.length > 0) {
    try {
      const latched = await kvGet<Record<string, number>>("lr_dispatch_latched", {});
      for (const m of triaged) {
        const ev = m.event;
        if (!ev?.meetingUrl || !ev.date || !ev.time) continue;
        if (latched[m.id]) continue;
        // Dubai local time, GMT+4, no DST. Schedule 30s pre-meeting.
        const localIso = `${ev.date}T${ev.time.padStart(5, "0")}:00+04:00`;
        const joinAt = new Date(localIso).getTime();
        if (Number.isNaN(joinAt) || joinAt < Date.now() + 60_000) continue; // too soon / past
        const scheduledAt = new Date(joinAt - 30_000).toISOString();
        const r = await dispatchMeetingBot({
          link: ev.meetingUrl,
          title: ev.title || m.subject || "Meeting",
          scheduledAt,
          displayName: "Digital Jensen",
        });
        if (r.ok) {
          latched[m.id] = Date.now();
          // Heads-up to Jensen so he is not surprised when the bot shows up.
          // Send via the chokepoint so the message lands in chat_messages and
          // can be inspected later. Best-effort; never blocks the auto-latch.
          try {
            const dubaiTime = ev.time;
            const recipient = recipientNumber();
            if (recipient) {
              const heads = `Heads up. I noticed a meeting invite for ${ev.title || m.subject || "a meeting"} at ${dubaiTime} today. I will join it as Digital Jensen and send you the notes and tasks when it ends. Reply "skip" if you would rather I do not.`;
              await sendTextAndLog(recipient, heads, { party: "jensen" });
            }
          } catch (e: any) {
            errors.push(`auto-latch heads-up ${m.id}: ${e?.message || String(e)}`);
          }
        } else {
          errors.push(`auto-latch ${m.id}: ${r.error}`);
        }
      }
      // FIFO cap to keep the kv row bounded.
      const entries: [string, number][] = Object.entries(latched);
      if (entries.length > 500) {
        entries.sort((a, b) => b[1] - a[1]);
        const trimmed: Record<string, number> = Object.fromEntries(entries.slice(0, 500));
        await kvSet("lr_dispatch_latched", trimmed).catch(() => {});
      } else {
        await kvSet("lr_dispatch_latched", latched).catch(() => {});
      }
    } catch (e: any) {
      errors.push(`auto-latch: ${e?.message || String(e)}`);
    }
  }

  // Surface both a real grounded draft AND a "needs your steer" ask (KT #332):
  // an ungrounded email has draft="" but must still reach Jensen as a question,
  // not be silently dropped.
  const needsReply = triaged.filter((m) => m.needsReply && ((m.draft || "").trim().length > 0 || m.needsSteer));
  // Thread coalescing: group emails by normalized subject and keep the most
  // recent per thread. Same thread showing up as 2+ separate proposals (e.g.
  // Thomas+Sohum + Petra+Sohum on the same purchasing thread) is noise, not
  // signal. The user can reply "what else in that thread" if they want more.
  const threadGroups = new Map<string, TriagedMail[]>();
  for (const m of needsReply) {
    // A blank/whitespace subject must NOT be dropped (KT #339): fall back to a
    // per-email key so a real client email with no subject still surfaces to Jensen
    // as its own proposal instead of being silently skipped.
    const key = (m.subject || "").replace(/^(Re|Fwd|Aw|Antwort|RE|FWD|AW):\s*/i, "").trim().toLowerCase().slice(0, 80) || `__nosubj_${m.id}`;
    if (!threadGroups.has(key)) threadGroups.set(key, []);
    threadGroups.get(key)!.push(m);
  }
  const coalesced: TriagedMail[] = [];
  for (const [, group] of threadGroups) {
    group.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const primary = { ...group[0] };
    if (group.length > 1) {
      primary.summary = `${group.length} emails in this thread. Latest: ${primary.summary}`;
    }
    coalesced.push(primary);
  }
  const notNeedingReply = triaged.length - needsReply.length;

  const to = recipientNumber();
  if (!to) {
    errors.push("OWNER_WHATSAPP not configured");
    return { ok: false, scanned: aggregated.length, newUnseen: unseen.length, proposed: 0, filteredNoise, notNeedingReply, seeded: false, windowOpen: win.open, queued: 0, drained: 0, errors };
  }

  let proposed = 0;
  let queued = 0;
  let drained = 0;

  // 1) Drain the off-window backlog FIRST if the window just reopened.
  // Order matters: catching Jensen up on what piled up while he was away
  // before showing him anything new from this tick.
  if (win.open) {
    const backlog = await drain();
    // Hard cap on a single drain so a long-away Jensen does not get hit by
    // 20 messages back-to-back the moment he says hi. Anything past the cap
    // stays unsurfaced; he can still ask "what's in my inbox" via list_inbox.
    const DRAIN_CAP = 5;
    const batch = backlog.slice(0, DRAIN_CAP);
    for (const p of batch) {
      try {
        const m: TriagedMail = {
          id: p.id, accountId: p.accountId, accountEmail: p.accountEmail,
          provider: "imap", from: p.from, fromEmail: p.fromEmail, subject: p.subject,
          date: "", snippet: "", seen: false, attachments: 0,
          important: p.quadrant === 1 || p.quadrant === 2,
          urgent: p.quadrant === 1 || p.quadrant === 3,
          needsReply: true, quadrant: p.quadrant, summary: p.summary, draft: p.draft,
          needsSteer: p.needsSteer, steerGap: p.steerGap,
        };
        const body1 = `(catching up while you were away)\n\n` + buildEmailBody(m);
        const r1 = await sendTextAndLog(to, body1, { party: "jensen" });
        if (!r1.ok) { errors.push(`drain send failed for ${p.id}`); continue; }
        await sendTextAndLog(to, m.needsSteer ? buildSteerAsk(m) : buildDraft(m), { party: "jensen" });
        drained++;
      } catch (e: any) {
        errors.push(`drain ${p.id}: ${e?.message || String(e)}`);
      }
    }
    if (backlog.length > DRAIN_CAP) {
      errors.push(`${backlog.length - DRAIN_CAP} more queued proposals dropped (over drain cap)`);
    }
  }

  // 2) Handle THIS tick's new needsReply items. In-window → propose now.
  // Off-window → queue for the next sweep that finds the window open.
  for (const m of coalesced) {
    try {
      if (win.open) {
        // Fetch the full email body so the user sees the actual content, not the
        // AI summary. Best-effort: if the fetch fails, fall through to snippet
        // or summary (buildEmailBody handles that).
        const withBody = { ...m };
        try {
          const full = await readUnified(m.id);
          if (full?.text) withBody.snippet = full.text;
        } catch { /* use snippet or summary fallback */ }
        // Capture the email content into the brain so a later reference resolves
        // ("what did Khalid email about"). Skip Q4 noise (newsletters/receipts).
        // Best-effort: memory must never block surfacing the mail.
        if (m.quadrant !== 4) {
          void rememberEmail({ from: m.from, fromEmail: m.fromEmail, subject: m.subject, date: m.date, body: withBody.snippet || m.summary }).catch(() => {});
        }
        const r = await sendTextAndLog(to, buildEmailBody(withBody), { party: "jensen" });
        if (r.ok) await sendTextAndLog(to, m.needsSteer ? buildSteerAsk(m) : buildDraft(m), { party: "jensen" });
        if (r.ok) proposed++;
        else errors.push(`whatsapp send failed for ${m.id}`);
      } else {
        const p: PendingProposal = {
          id: m.id, accountId: m.accountId, accountEmail: m.accountEmail,
          from: m.from, fromEmail: m.fromEmail, subject: m.subject,
          summary: m.summary, draft: m.draft, quadrant: m.quadrant,
          queuedAt: Date.now(),
          needsSteer: m.needsSteer, steerGap: m.steerGap,
        };
        await enqueue(p);
        queued++;
      }
    } catch (e: any) {
      errors.push(`propose ${m.id}: ${e?.message || String(e)}`);
    }
  }

  return { ok: errors.length === 0, scanned: aggregated.length, newUnseen: unseen.length, proposed, filteredNoise, notNeedingReply, seeded: false, windowOpen: win.open, queued, drained, errors: errors.length ? errors : undefined };
}
