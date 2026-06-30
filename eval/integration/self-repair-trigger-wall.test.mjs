#!/usr/bin/env node
// SELF-REPAIR TRIGGER WALL (KT #206540, Mode 1). 2026-06-30.
//
// Bug shape (live, to the real client): Jensen sent
//   "https://teams.live.com/... MEETING WITH TAONA AND MARGOT 10AM MONDAY 6TH
//    JULY, SAVE THE LINK"
// The model narrated a finished action but called NO tool, so create_event never
// ran; the honesty rail could only emit the dead "I have not done that yet" stub.
// The loop now fires ONE forced-tool repair round when, and ONLY when,
// isUnbackedClaim() is true. This wall pins that trigger so a future edit cannot
// (a) stop it firing on the real bug, or (b) make it fire on safe turns and force
// a tool where none was wanted.
//
// Pure local. No DB, no Anthropic spend, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnbackedClaim } from "../../lib/concierge/honest-reply.ts";

const NO_RUNS = [];
const okEvent = [{ name: "create_event", ok: true, result: { title: "x" } }];
const failingEvent = [{ name: "create_event", ok: false, result: { summary: "Two events match, which one?" } }];

test("FIRES: completion claim with no tool call (the live calendar bug)", () => {
  assert.equal(isUnbackedClaim("Done. Meeting with Taona and Margot is on the calendar for Monday 6 July at 10:00.", NO_RUNS, "save the link"), true);
  assert.equal(isUnbackedClaim("Saved the link for you.", NO_RUNS, "save this link"), true);
  assert.equal(isUnbackedClaim("I've added that contact.", NO_RUNS, "add contact"), true);
});

test("DOES NOT FIRE: a tool actually ran (backed claim -> Mode 2, handled elsewhere)", () => {
  assert.equal(isUnbackedClaim("Done. The event is set.", okEvent, "create event"), false);
});

test("DOES NOT FIRE: a tool ran and failed with a useful message (surface that, do not retry)", () => {
  assert.equal(isUnbackedClaim("Done.", failingEvent, "delete the meeting"), false);
});

test("DOES NOT FIRE: not a completion claim (a question / future / clarifying reply)", () => {
  assert.equal(isUnbackedClaim("Give me his email and I'll send it straight away.", NO_RUNS, "email khalid"), false);
  assert.equal(isUnbackedClaim("What time would you like the meeting?", NO_RUNS, "set a meeting"), false);
  assert.equal(isUnbackedClaim("I can do that once you confirm.", NO_RUNS, "do it"), false);
});

test("DOES NOT FIRE: empty reply (handled by a different honest fallback)", () => {
  assert.equal(isUnbackedClaim("", NO_RUNS, "anything"), false);
});

test("DOES NOT FIRE: a recap/summary answer with past-tense verbs (KT #334 over-fire guard)", () => {
  assert.equal(isUnbackedClaim("Earlier you saved two vendors and set the Talal meeting.", NO_RUNS, "summarise my day"), false);
});
