// Pull readable text out of an uploaded file's raw bytes. Thin Jensen adapter
// over @zanii/intake's extractTextFromBuffer primitive (PDF via unpdf,
// Word via mammoth, spreadsheets via SheetJS, plain text directly).
//
// Signature preserved: the third arg is still `name` (used as a filename
// extension fallback when the MIME header is missing or generic — common for
// WhatsApp Cloud document uploads where mime arrives as
// application/octet-stream). Intake only sniffs the MIME, so we normalise it
// here from the extension before handing off. Images/scans have no text layer
// and remain handled by vision OCR upstream. Never throws.

import { extractTextFromBuffer as intakeExtract } from "./intake/index.js";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC = "application/msword";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS = "application/vnd.ms-excel";
const CSV = "text/csv";
const TXT = "text/plain";

function normaliseMime(mime: string, name: string): string {
  const m = (mime || "").toLowerCase();
  const lower = (name || "").toLowerCase();
  // Trust explicit MIME first.
  if (m === PDF || m === DOCX || m === DOC || m === XLSX_MIME || m === XLS || m === CSV) return m;
  if (m.startsWith("text/") || m === "application/json") return m;
  // Fall back to the filename extension (WhatsApp documents often arrive as
  // application/octet-stream).
  if (lower.endsWith(".pdf")) return PDF;
  if (lower.endsWith(".docx")) return DOCX;
  if (lower.endsWith(".doc")) return DOC;
  if (lower.endsWith(".xlsx")) return XLSX_MIME;
  if (lower.endsWith(".xls")) return XLS;
  if (lower.endsWith(".csv")) return CSV;
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return TXT;
  return m || "application/octet-stream";
}

export async function extractTextFromBuffer(buf: Buffer | Uint8Array, mime: string, name = ""): Promise<string | null> {
  const normalised = normaliseMime(mime, name);
  return intakeExtract(buf, normalised);
}
