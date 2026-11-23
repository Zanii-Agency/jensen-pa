// @zanii/brain-core/discriminator
//
// Pure logic for the "discriminator-name wall" from KT #293 (2026-06-15). The
// case that motivated this: operator says "meeting taona done", the bot's
// matcher resolves a candidate task titled "meeting with haneen", the
// candidate title carries a team-member first-name the operator did NOT name
// in their last inbound message and DID name a different one. Refuse the
// write before it corrupts state.
//
// Lifted to brain-core 2026-06-16 as the first proof of the cross-bot tool
// registry pattern. Sasa stored its team roster in `team_members` and read
// last-inbound from `messages.contact_id=X AND direction='in'`. Jensen stores
// people in `contacts` and reads last-inbound from `chat_messages.party=X`.
// Different DB shapes, identical regex logic. The bot supplies two adapter
// callbacks; the primitive lives here.
//
// Where else it fires: every future bot with a "complete-an-item-by-name"
// primitive over a multi-person team. CTH does not have this surface yet
// (vendors bot, no team-member resolution); skip CTH until the surface
// exists.
// Word-boundary regex factory. The (^|[^a-z]) and ([^a-z]|$) form is the
// regex-equivalent of \b that ALSO treats apostrophes and accented chars
// as boundaries. Catches "Toana" in "Toana done" but not "toanapple".
function nameRe(n) {
    return new RegExp(`(^|[^a-z])${n}([^a-z]|$)`, "i");
}
export async function discriminatorMismatch(candidateTitle, adapters) {
    try {
        const titleLower = String(candidateTitle || "").toLowerCase();
        const firstNames = (await adapters.getActiveTeamFirstNames())
            .map((s) => String(s || "").trim().toLowerCase())
            .filter((s) => s && s.length >= 3);
        const namesInTitle = Array.from(new Set(firstNames.filter((n) => nameRe(n).test(titleLower))));
        // Zero or 2+ names in title means no single-target to discriminate.
        // (2+ would be a different bug class: ambiguous task title.)
        if (namesInTitle.length !== 1)
            return { ok: true };
        const lastInbound = (await adapters.getLastUserInbound()) || "";
        const userBody = String(lastInbound).toLowerCase();
        if (!userBody)
            return { ok: true };
        // length === 1 verified above, so [0] is defined; assert for TS.
        const expected = namesInTitle[0];
        // User named the expected person: no mismatch.
        if (nameRe(expected).test(userBody))
            return { ok: true };
        // User named a different team-member: refuse.
        const userNamed = firstNames.filter((n) => n !== expected && nameRe(n).test(userBody));
        if (userNamed.length === 0)
            return { ok: true };
        return { ok: false, expected, got: userNamed[0] };
    }
    catch {
        // Fail-open on adapter errors: the discriminator is a safety net, not
        // a correctness gate. A flaky DB at the moment of evaluation must not
        // refuse a legitimate close.
        return { ok: true };
    }
}
//# sourceMappingURL=discriminator.js.map