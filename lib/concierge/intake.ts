// Document intake runs out-of-band from the chat brain so the bot already
// "knows" any file Jensen drops. The bot READS (chunk + embed + remember) so
// future questions can ground on his documents. WRITES that change Jensen's
// world (finance row for an invoice) are GATED by onboarding: in listen-only
// mode we observe and remember, we do not act. KT #146: a "read-only" intake
// path silently wrote to finance and broke the no-doing rule.

import { claudeJSON, NO_DASHES } from "../anthropic";
import * as ops from "./ops";
import { rememberFact } from "./brain";

const FOLDERS = ["finance", "legal", "identity", "contracts", "clients", "venues", "events", "menus", "branding", "reports", "general"];

const SYS =
  `Classify a document for La Rencontre, a luxury F&B hospitality consultancy in Dubai. ` +
  `Return JSON {folder, summary, isInvoice, amount, currency, vendor, date}. ` +
  `folder MUST be one of: ${FOLDERS.join(", ")}. ` +
  `isInvoice true ONLY for an invoice, receipt, or bill. ` +
  `amount = the net total as a plain number if clearly shown, else null (NEVER guess a number). ` +
  `currency like AED. date = ISO YYYY-MM-DD if shown, else null. ` +
  `summary = one short line of what the document is and why it matters. ${NO_DASHES}`;

export type Filed = {
  folder: string;
  summary: string;
  finance: { amount: number; label: string } | null;
  pending?: { kind: "expense"; amount: number; currency?: string; label: string; date?: string } | null;
};

export async function classifyAndFile(
  doc: { id: string; title: string; text: string; entityId?: string; dataUrl?: string },
  opts?: { onboarding?: boolean },
): Promise<Filed> {
  const onboarding = !!opts?.onboarding;
  let c: any = null;
  try {
    c = await claudeJSON(SYS, `Title: ${doc.title}\n\n${doc.text.slice(0, 4000)}`, 400);
  } catch { /* classify best-effort */ }
  const folder = FOLDERS.includes(c?.folder) ? c.folder : "general";

  // Folder = classification metadata for retrieval. Safe in either mode.
  await ops.fileDocument({ id: doc.id, folder, entityId: doc.entityId }).catch(() => {});

  let finance: { amount: number; label: string } | null = null;
  let pending: Filed["pending"] = null;
  if (c?.isInvoice && typeof c.amount === "number" && c.amount > 0) {
    const label = c.vendor || doc.title;
    if (onboarding) {
      // LISTEN-ONLY: surface what we saw but do NOT write to finance.
      pending = { kind: "expense", amount: c.amount, currency: c.currency || "AED", label, date: c.date || undefined };
    } else {
      // Link the expense back to the vaulted receipt file (doc.dataUrl = storage
      // path) so the number traces to its source image (Law 6), and tag the row
      // source=receipt so it is distinguishable from a hand-entered expense.
      await ops.recordFinance({ kind: "expense", amount: c.amount, vatApplies: true, label, date: c.date || undefined, receiptUrl: doc.dataUrl, source: "receipt" }).catch(() => {});
      finance = { amount: c.amount, label };
    }
  }

  // Always remember the document in plain language so the brain can recall it.
  await rememberFact(
    `Document on file: "${doc.title}" [${folder}]${c?.summary ? ` — ${c.summary}` : ""}.`,
    { kind: onboarding ? "onboarding_fact" : "fact", source: "document", subject: doc.title }
  ).catch(() => {});

  return { folder, summary: c?.summary || doc.title, finance, pending };
}
