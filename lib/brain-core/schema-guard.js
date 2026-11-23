// @zanii/brain-core/schema-guard
//
// Boot-time schema-drift detector. Built after the 2026-06-15 Sasa cascade
// (KT #295): the swipe-reply migration shipped as code without being applied
// to prod, every inbound hit 42703 reply_to_external_id-missing, ingress
// silently failed, and the agent emitted 12 off-topic replies on stale
// history before the operator caught it from her phone.
//
// The lesson is that a bot whose code references a column the schema does
// not yet have is structurally broken on its first relevant inbound. This
// helper queries each (table, columns) pair from a bot-supplied manifest at
// startup and reports drift. The caller decides what to do with the result:
// crash, degrade, emit a banner, page an operator. This package is empty
// machinery, it never decides for the tenant.
//
// Manifest shape: { [tableName]: [columnName, ...] }. The bot lists every
// column its INSERT/UPDATE paths touch. SELECT-only columns that are
// optional in the response can be omitted, but listing them costs almost
// nothing and catches drift earlier.
// PostgreSQL SQLSTATE classes we treat as schema drift (vs transient).
// Mirror of webhook/route.ts SCHEMA_DRIFT_CODES on Sasa (KT #295).
const SCHEMA_DRIFT_SQLSTATES = new Set([
    "42703", // undefined_column
    "42P01", // undefined_table
    "42883", // undefined_function
    "42704", // undefined_object (type, enum, operator)
    "23502", // not_null_violation (column added NOT NULL without default)
    "42P10", // undefined_column in ON CONFLICT
]);
export async function checkSchema(opts) {
    const { db, manifest } = opts;
    const missing = [];
    const driftCodes = [];
    let checkedTables = 0;
    let checkedColumns = 0;
    for (const table of Object.keys(manifest)) {
        const cols = manifest[table];
        if (!cols || cols.length === 0)
            continue;
        checkedTables++;
        checkedColumns += cols.length;
        // First pass: select all columns at once. Fast path when nothing has drifted.
        const { error } = await db.from(table).select(cols.join(",")).limit(0);
        if (!error)
            continue;
        const code = String(error.code || "");
        if (code === "42P01") {
            // Whole table is missing — record once and move on.
            missing.push({ table, column: "(table itself)" });
            continue;
        }
        if (code === "42703") {
            // At least one column is missing. Probe per-column to identify which.
            for (const col of cols) {
                const { error: e2 } = await db.from(table).select(col).limit(0);
                if (!e2)
                    continue;
                const c2 = String(e2.code || "");
                if (c2 === "42703")
                    missing.push({ table, column: col });
                else if (SCHEMA_DRIFT_SQLSTATES.has(c2)) {
                    driftCodes.push({ table, code: c2, message: String(e2.message || "").slice(0, 200) });
                }
            }
            continue;
        }
        if (SCHEMA_DRIFT_SQLSTATES.has(code)) {
            driftCodes.push({ table, code, message: String(error.message || "").slice(0, 200) });
            continue;
        }
        // Transient (network, timeout, etc.) — not drift. Ignore so a flaky DB
        // probe at boot does not crash a healthy app.
    }
    return {
        ok: missing.length === 0 && driftCodes.length === 0,
        missing,
        driftCodes,
        checkedTables,
        checkedColumns,
    };
}
// Convenience formatter for log/event output.
export function formatSchemaResult(r) {
    if (r.ok)
        return `schema OK: ${r.checkedColumns} columns across ${r.checkedTables} tables`;
    const parts = [];
    if (r.missing.length) {
        parts.push("MISSING: " + r.missing.map((m) => `${m.table}.${m.column}`).join(", "));
    }
    if (r.driftCodes.length) {
        parts.push("DRIFT: " + r.driftCodes.map((d) => `${d.table} ${d.code} ${d.message}`).join("; "));
    }
    return parts.join(" | ");
}
//# sourceMappingURL=schema-guard.js.map