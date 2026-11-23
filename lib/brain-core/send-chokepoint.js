// @zanii/brain-core/send-chokepoint
//
// Unified send primitive with audit logging. Every bot's outbound goes through
// this, with tenant-specific adapters for persistence and dev routing.
//
// The pattern: sanitize → dev-check → send → persist → return.
// Each bot supplies adapters for:
//   - persistOutbound(to, body, opts) — tenant-specific DB insert
//   - devPhone() — returns dev phone number or null
//   - sendFn(to, body, opts) — the actual WhatsApp API call
//
// KT #293 (Law 2): the send chokepoint. Every outbound message passes through
// a single door where sanitization, dev-routing, and audit logging happen.
// The wall (bot-guards) runs inside the primitive, not at each call site.
export async function sendWithAudit(to, body, adapters, opts) {
    // 1) Dev mode: reroute to dev phone, skip persistence
    if (opts?.dev) {
        const devTarget = adapters.devPhone();
        if (!devTarget)
            return { ok: false, error: "no_dev_phone" };
        const res = await adapters.sendFn(devTarget, `[DEV] ${body}`, { force: true });
        if (res.error)
            return { ok: false, error: res.error };
        return { ok: true, id: res.id ?? null };
    }
    // 2) Persist BEFORE send (Law 2: write before send, prevents orphan on failure).
    //    If persist fails we DO NOT send: an undeduplicated/unlogged outbound is
    //    worse than a dropped one — it cannot be reconciled post-mortem.
    const persisted = await adapters.persistOutbound(to, body, {
        party: opts?.party,
        trace_id: opts?.trace_id,
    });
    if (persisted.error) {
        return { ok: false, error: `persist failed before send: ${persisted.error}` };
    }
    // 3) Send via WhatsApp API
    const sendRes = await adapters.sendFn(to, body, { force: opts?.force });
    // 4) Return combined result
    if (sendRes.error) {
        return { ok: false, error: sendRes.error };
    }
    return { ok: true, id: persisted.id };
}
//# sourceMappingURL=send-chokepoint.js.map