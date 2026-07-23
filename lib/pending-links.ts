// Parked-link buffer (Jensen-elevation Phase 1). When Jensen sends a meeting link
// before its calendar event exists, or when the message has no confident event to
// attach to, the link must NOT be dropped or guessed onto the wrong meeting
// (incidents B and D). We PARK it keyed by sender, then attach it when a matching
// event is later created/updated. Reuses the existing `kv` table (no migration)
// and the tested resolveEventByIdentity matcher, so a parked link only ever lands
// on an event whose identity its original message actually names.
//
// Fail-open: every DB touch is wrapped. A parking failure degrades to "link not
// remembered" (the bot will ask again), never to a wrong attach or a throw.

import { admin } from "./db";
import { resolveEventByIdentity } from "./digital-u";

const KEY = (sender: string) => `pendinglink:${sender}`;
const TTL_MS = 7 * 24 * 3600 * 1000; // a week; a link older than this is stale

type Parked = { url: string; hint: string; ts: number };

// Pure decision (unit-testable, no DB): index of the FIRST parked link whose
// original message identity-names this event title, or -1. Never matches on
// scaffold words (resolveEventByIdentity guards that) so a Sotiris link cannot
// be claimed by an A2 Milk event.
export function pickParkedLink(list: Parked[], eventTitle: string): number {
  return (list || []).findIndex(
    (l) => l && resolveEventByIdentity(l.hint, [{ id: "x", title: eventTitle }]) !== null,
  );
}

// Park a link with the message that carried it (the hint), for later identity
// resolution. Deduped by url. Stale entries are pruned on every write.
export async function parkLink(sender: string | null, url: string, hint: string): Promise<void> {
  if (!sender || !url) return;
  try {
    const db = admin();
    const { data } = await db.from("kv").select("value").eq("key", KEY(sender)).limit(1);
    const now = Date.now();
    const trimmedHint = String(hint || "").slice(0, 280);
    // Dedup on (url, hint) not url alone (skeptic F5): the same personal-room link
    // can legitimately belong to two meetings; only a true re-send of the SAME
    // message is a duplicate.
    const list: Parked[] = ((data?.[0]?.value?.links as Parked[]) || [])
      .filter((l) => l && now - l.ts < TTL_MS && !(l.url === url && l.hint === trimmedHint));
    list.push({ url, hint: trimmedHint, ts: now });
    // zanii-codef: cap 10 parked links/sender — a single tenant never has more
    // outstanding; oldest is evicted. Raise if a real backlog ever exceeds it.
    await db.from("kv").upsert({ key: KEY(sender), value: { links: list.slice(-10) } });
  } catch { /* fail-open: link simply not parked */ }
}

// When an event is created/updated for this sender, claim the FIRST parked link
// whose original message identity-matches the event title, and remove it from the
// buffer. Returns the url to attach, or null. Never returns a link whose message
// does not name this event (resolveEventByIdentity returns null on no/ambiguous
// match), so a parked Sotiris link never lands on an A2 Milk event.
export async function takeParkedLinkFor(sender: string | null, eventTitle: string): Promise<string | null> {
  if (!sender || !eventTitle) return null;
  try {
    const db = admin();
    const { data } = await db.from("kv").select("value").eq("key", KEY(sender)).limit(1);
    const now = Date.now();
    const list: Parked[] = ((data?.[0]?.value?.links as Parked[]) || []).filter((l) => l && now - l.ts < TTL_MS);
    if (!list.length) return null;
    const idx = pickParkedLink(list, eventTitle);
    if (idx < 0) return null;
    const [claimed] = list.splice(idx, 1);
    await db.from("kv").upsert({ key: KEY(sender), value: { links: list } });
    return claimed.url;
  } catch {
    return null; // fail-open: caller just doesn't attach a parked link this time
  }
}
