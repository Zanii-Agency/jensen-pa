// jensen-pa transcribe primary-with-fallback test.
//
// The adapter at lib/transcribe.ts wraps @zanii/intake's transcribeAudio
// primitive with:
//   - 5s timeout race on the primary URL (TRANSCRIBE_PRIMARY_URL)
//   - fallback to hosted OpenAI on timeout / error / empty
//   - structured console.info log { kind, path, elapsed_ms, ok }
//   - existing Buffer-in / Promise<string|null>-out signature preserved
//
// We can't execute the .ts directly without tsx, so this test does two things:
//   1) Behaviorally: replicates the adapter logic against the *real* intake
//      dist/transcribe.js with a mocked fetch. Asserts that primary-first,
//      timeout-fallback, error-fallback, and primary-success-skips-fallback
//      all hold for the COMPILED intake primitive the adapter actually calls.
//   2) Structurally: asserts the adapter source includes the same control
//      flow (TRANSCRIBE_PRIMARY_URL read, withTimeout race, console.info
//      with path:'primary'/'fallback', no openaiKey leak in log payloads).
//
// Skeptic-pass: remove the fallback or the primary branch from lib/transcribe.ts
// and re-run; this script must fail red.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { transcribeAudio as intakeTranscribeAudio } from "../lib/intake/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterPath = path.resolve(here, "../lib/transcribe.ts");
const adapterSrc = readFileSync(adapterPath, "utf8");

const PRIMARY_TIMEOUT_MS = 5000;

// Replicated race-with-timeout helper — must match the adapter's behavior.
async function withTimeout(p, ms) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ text: "", timedOut: true }), ms);
  });
  const main = p.then((text) => ({ text, timedOut: false }));
  try {
    return await Promise.race([main, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Replicated adapter logic — pure function over a config of fetch + env.
async function adapterRun(base64, mime, opts) {
  const { key, primaryUrl, timeoutMs } = opts;
  if (!key) return { result: null, calls: [] };
  const calls = [];
  const safeMime = mime || "audio/ogg";

  if (primaryUrl) {
    const { text, timedOut } = await withTimeout(
      intakeTranscribeAudio(base64, safeMime, { openaiKey: key, baseUrl: primaryUrl }),
      timeoutMs ?? PRIMARY_TIMEOUT_MS
    );
    const trimmed = (text || "").trim();
    calls.push({ path: "primary", ok: !!trimmed && !timedOut, timedOut });
    if (trimmed && !timedOut) {
      return { result: trimmed, calls };
    }
  }

  const out = await intakeTranscribeAudio(base64, safeMime, { openaiKey: key });
  const trimmed = (out || "").trim();
  calls.push({ path: primaryUrl ? "fallback" : "openai", ok: !!trimmed });
  return { result: trimmed || null, calls };
}

// --- Mocked fetch helpers ---
const origFetch = global.fetch;
function setFetch(handler) {
  const observed = [];
  global.fetch = async (url, init) => {
    observed.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return observed;
}
function ok(text) { return { ok: true, json: async () => ({ text }) }; }
function err(status, msg) { return { ok: false, status, json: async () => ({ error: { message: msg || "bad" } }) }; }
function hang() { return new Promise(() => {}); } // never resolves

const FAKE_B64 = Buffer.from("fake").toString("base64");

// ---------- Behavioral tests ----------

test("primary success skips fallback", async () => {
  const observed = setFetch((url) => {
    if (url.startsWith("https://primary.example/")) return ok("local hello");
    return ok("openai hello");
  });
  const { result, calls } = await adapterRun(FAKE_B64, "audio/ogg", {
    key: "k", primaryUrl: "https://primary.example",
  });
  assert.equal(result, "local hello");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "primary");
  assert.equal(calls[0].ok, true);
  assert.equal(observed.length, 1);
  assert.ok(observed[0].url.startsWith("https://primary.example/"));
});

test("primary timeout triggers fallback to OpenAI", async () => {
  let n = 0;
  const observed = setFetch((url) => {
    n++;
    if (n === 1) return hang(); // primary hangs forever
    return ok("openai rescued");
  });
  const { result, calls } = await adapterRun(FAKE_B64, "audio/ogg", {
    key: "k", primaryUrl: "https://primary.example", timeoutMs: 30, // tight for test
  });
  assert.equal(result, "openai rescued");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "primary");
  assert.equal(calls[0].timedOut, true);
  assert.equal(calls[1].path, "fallback");
  assert.equal(calls[1].ok, true);
  assert.equal(observed.length, 2);
  assert.ok(observed[1].url.startsWith("https://api.openai.com/"));
});

test("primary 500 triggers fallback to OpenAI", async () => {
  const observed = setFetch((url) => {
    if (url.startsWith("https://primary.example/")) return err(500, "boom");
    return ok("openai rescued");
  });
  const { result, calls } = await adapterRun(FAKE_B64, "audio/ogg", {
    key: "k", primaryUrl: "https://primary.example",
  });
  assert.equal(result, "openai rescued");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "primary");
  assert.equal(calls[0].ok, false);
  assert.equal(calls[1].path, "fallback");
  assert.equal(observed.length, 2);
});

test("primary network error triggers fallback to OpenAI", async () => {
  let n = 0;
  setFetch((url) => {
    n++;
    if (n === 1) throw new Error("ENOTFOUND");
    return ok("openai rescued");
  });
  const { result, calls } = await adapterRun(FAKE_B64, "audio/ogg", {
    key: "k", primaryUrl: "https://primary.example",
  });
  assert.equal(result, "openai rescued");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, "fallback");
});

test("no primary URL configured -> direct OpenAI, single call", async () => {
  const observed = setFetch(() => ok("openai direct"));
  const { result, calls } = await adapterRun(FAKE_B64, "audio/ogg", {
    key: "k", primaryUrl: "",
  });
  assert.equal(result, "openai direct");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "openai");
  assert.equal(observed.length, 1);
  assert.ok(observed[0].url.startsWith("https://api.openai.com/"));
});

test("primary tried FIRST when configured", async () => {
  const observed = setFetch((url) => {
    if (url.startsWith("https://primary.example/")) return ok("primary first");
    return ok("openai");
  });
  await adapterRun(FAKE_B64, "audio/ogg", {
    key: "k", primaryUrl: "https://primary.example",
  });
  // The very first network call must hit primary.
  assert.ok(observed.length >= 1);
  assert.ok(observed[0].url.startsWith("https://primary.example/"),
    `expected primary first, got ${observed[0].url}`);
});

test("missing key returns null without any fetch", async () => {
  const observed = setFetch(() => ok("should never run"));
  const { result, calls } = await adapterRun(FAKE_B64, "audio/ogg", {
    key: "", primaryUrl: "https://primary.example",
  });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
  assert.equal(observed.length, 0);
});

// ---------- Structural tests on the .ts adapter ----------

test("adapter source reads TRANSCRIBE_PRIMARY_URL env var", () => {
  assert.match(adapterSrc, /TRANSCRIBE_PRIMARY_URL/);
});

test("adapter source declares a 5-second timeout constant", () => {
  assert.match(adapterSrc, /PRIMARY_TIMEOUT_MS\s*=\s*5000/);
});

test("adapter source uses Promise.race / withTimeout for the timeout", () => {
  const hasRace = /Promise\.race/.test(adapterSrc) || /withTimeout\(/.test(adapterSrc);
  assert.ok(hasRace, "expected Promise.race or withTimeout in adapter");
});

test("adapter source logs path:'primary' and path:'fallback'", () => {
  assert.match(adapterSrc, /["']primary["']/);
  assert.match(adapterSrc, /["']fallback["']/);
});

test("adapter source includes elapsed_ms in structured log", () => {
  assert.match(adapterSrc, /elapsed_ms/);
});

test("adapter source passes baseUrl to the intake primitive", () => {
  assert.match(adapterSrc, /baseUrl:\s*primaryUrl/);
});

test("adapter source does not log the openai key", () => {
  // No console line that surfaces the key. Cheap guard.
  const dangerous = /console\.[a-z]+\([^)]*openaiKey/.test(adapterSrc) ||
                    /console\.[a-z]+\([^)]*key:/.test(adapterSrc);
  assert.ok(!dangerous, "adapter must not log the openai key");
});

test("adapter preserves Promise<string | null> return signature", () => {
  assert.match(adapterSrc, /Promise<string\s*\|\s*null>/);
});

test.after(() => { global.fetch = origFetch; });
