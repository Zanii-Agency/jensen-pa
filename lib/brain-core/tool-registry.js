// @zanii/brain-core/tool-registry
//
// Cross-bot tool primitive contract. Started 2026-06-16 as the foundation
// for [[KT #229]] wall-at-primitive scaled across the fleet.
//
// The pattern: brain-core ships PURE LOGIC primitives (regex-only honesty
// guards, the discriminator, schema-drift detection). Each bot supplies
// adapters that wire the primitive to its own DB shape, persona, and
// audience rules. Today's first registered primitive is the discriminator;
// future commits add complete-target resolution, send chokepoint shape,
// honesty-guard composition.
//
// The registry itself is intentionally MINIMAL today — just the contract
// + a register/list pair for introspection. Tomorrow's dream cycle (KT
// follow-up, the C-half of Pete-style self-improvement) reads from the
// registry to know what primitives exist and which ones a transcript
// could improve.
// In-memory registry. Bots that want to enumerate their wired primitives
// (e.g. for /tools introspection or the dream cycle) call list().
const REGISTRY = new Map();
export function register(primitive) {
    if (REGISTRY.has(primitive.name)) {
        throw new Error(`tool-registry: primitive "${primitive.name}" already registered`);
    }
    REGISTRY.set(primitive.name, primitive);
}
export function list() {
    return Array.from(REGISTRY.values()).sort((a, b) => a.name.localeCompare(b.name));
}
export function get(name) {
    return REGISTRY.get(name);
}
// Test-only escape hatch. Production code never calls this.
export function _resetForTest() {
    REGISTRY.clear();
}
//# sourceMappingURL=tool-registry.js.map