// @sinanagency/brain-core/webhook-guard
//
// Cross-bot webhook dedup + media-pending buffer. Shared logic that every
// WhatsApp bot in the fleet needs because Meta sends:
//   1. Duplicate webhooks with different wamids for the same message
//   2. Image+text as two separate webhooks (text arrives first, short)
//
// Each bot supplies adapters (seenByWamid, logToChat) that wire to its own
// Supabase tables. The primitive lives here, the adapters live in the bot.
//
// KT #302 (2026-06-16): ported from the hand-rolled concurrency guard in
// Jensen's route.ts that proved the pattern before the brain-core lift.
// Ported to brain-core v0.8 as the second cross-bot primitive (after
// discriminatorMismatch, v0.7).
const PROCESSING_LOCKS = new Map();
const MEDIA_PENDING = new Map();
const MEDIA_WAIT_MS = 2500;
function resolveMediaRef(text) {
    return /^(this|here|see|attached|image|photo|pic|screenshot|look|check|this is|here is|see attached|see this)$/i
        .test(String(text || "").trim());
}
export async function shouldProcess(adapterName, sender, wamid, text, adapters, opts) {
    if (wamid) {
        const seen = await adapters.seenByWamid(wamid);
        if (seen)
            return { action: "skip", reason: "duplicate_wamid" };
    }
    // A message that actually CARRIES media must never enter the media-pending
    // buffer or the per-sender lock below. The buffer exists to hold a SHORT TEXT
    // reference ("here", "see attached") until the image webhook lands; the lock
    // exists to drop rapid duplicate TEXT webhooks. Distinct images each carry a
    // distinct wamid, so the wamid dedup at the top already rejects a genuine
    // re-delivery of the SAME image. For media, the lock/buffer add nothing but
    // the drop (Stalia, 2026-09-01: a portal screenshot then the real bank proof
    // arrived within 2s; the second was skipped as a duplicate and lost).
    const carriesMedia = Boolean(opts && opts.hasMedia);
    const now = Date.now();
    const lockKey = `${adapterName}::${sender}`;
    // Try optional cross-instance lock first. If another Vercel instance holds
    // the lock, skip (same as the in-process guard below).
    if (adapters.acquireLock) {
        const acquired = await adapters.acquireLock(lockKey, 4000);
        if (!acquired) {
            if (text)
                await adapters.logToChat(sender, text).catch(() => { });
            return { action: "skip", reason: "concurrent_duplicate" };
        }
    }
    // Media-pending buffer: if the inbound looks like a media reference
    // ("this", "here", "see attached"), wait briefly for a media webhook
    // to arrive from the same sender before releasing. The 2s sender-lock
    // runs AFTER this block so the media webhook is not blocked by the
    // text webhook's lock (June 18 bug: lock before buffer made the
    // entire media-pending path non-functional because the image arrived
    // while the text held the lock).
    if (!carriesMedia && text && resolveMediaRef(text)) {
        MEDIA_PENDING.set(sender, { text, ts: now });
        let timedOut = false;
        await new Promise((resolve) => {
            const iv = setInterval(() => {
                if (!MEDIA_PENDING.has(sender)) {
                    clearInterval(iv);
                    resolve();
                }
            }, 100);
            setTimeout(() => {
                clearInterval(iv);
                timedOut = true;
                const buf = MEDIA_PENDING.get(sender);
                if (buf && buf.ts === now)
                    MEDIA_PENDING.delete(sender);
                resolve();
            }, MEDIA_WAIT_MS);
        });
        if (timedOut)
            return { action: "process" };
        return { action: "skip", reason: "merged_with_media" };
    }
    // Per-sender lock: prevents two webhooks for the same sender within 2s
    // from both being processed (Meta batch behaviour). MEDIA IS EXEMPT (see the
    // carriesMedia note above): two distinct images sent within 2s each have a
    // distinct wamid, so the wamid dedup already catches a true re-delivery; the
    // lock here would only drop the second distinct image. So it guards non-media
    // (rapid duplicate text webhooks) alone.
    if (!carriesMedia) {
        const lastSeen = PROCESSING_LOCKS.get(lockKey);
        if (lastSeen !== undefined && now - lastSeen < 2000) {
            if (text)
                await adapters.logToChat(sender, text).catch(() => { });
            return { action: "skip", reason: "concurrent_duplicate" };
        }
        PROCESSING_LOCKS.set(lockKey, now);
    }
    return { action: "process" };
}
export function mediaArrived(sender) {
    const buf = MEDIA_PENDING.get(sender);
    if (!buf)
        return null;
    MEDIA_PENDING.delete(sender);
    return buf.text;
}
export function _resetForTest() {
    PROCESSING_LOCKS.clear();
    MEDIA_PENDING.clear();
}
//# sourceMappingURL=webhook-guard.js.map