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
import { isUnbackedClaim, honestReply, isReadIntent } from "../../lib/concierge/honest-reply.ts";

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

// FALSE-NEGATIVE FIX (2026-06-30, live to Jensen): a SUCCESSFUL create_event whose
// reply mentions the reminder with a send-ish verb ("notified"/"sent") was being
// rewritten to "I have not done that yet" though the event row existed. A real
// success must never be reported as a failure. isBacked() now treats any
// completion-tool success as backing, regardless of incidental send words.
test("DOES NOT FIRE: successful create + send-word reply is backed, not a trigger", () => {
  assert.equal(isUnbackedClaim("Saved your meeting with Taona and Margot at 10:00. I have notified your reminder to include the link.", okEvent, "save the link"), false);
  assert.equal(isUnbackedClaim("Done, the meeting is saved and I have sent it to your reminder.", okEvent, "save the link"), false);
});

test("honestReply ships a successful create even when the reply uses a send-word (no stub)", async () => {
  const out = await honestReply("Done. Saved the meeting with Taona and Margot and notified your reminder to carry the link.", okEvent, "save the link");
  assert.equal(out.startsWith("I have not done that yet"), false);
});

test("honestReply STILL stubs a pure sent-claim with no send tool (guard intact)", async () => {
  const out = await honestReply("Done, I emailed Khalid the new time.", NO_RUNS, "email khalid the new time");
  assert.equal(out.startsWith("I have not done that yet"), true);
});

// READ-INTENT WALL (live incident, 2026-07-21). When Jensen asks to SEE his state
// ("give me my updated list", "what are my meetings tomorrow"), a reply with
// past-tense verbs ("set", "booked", "on the calendar") describes EXISTING records,
// not a fresh action this turn. Two harms this pins shut:
//   (a) honestReply rewrote such reads to the dead "I have not done that yet" stub
//       ("what are my meetings tomorrow?" -> hollow, 07-15).
//   (b) isUnbackedClaim=true fired the loop's self-repair force-tool on a READ,
//       which made the model INVENT a create_event ("Meeting with Malik is now on
//       the calendar") that Jensen never asked for (08:36, 07-21).
// A read ask must NEVER trigger either. An ACTION ask still does.
test("isReadIntent: recognises schedule/board reads, rejects action requests", () => {
  for (const s of [
    "what are my meetings tomorrow",
    "what are my meeting and reminder for today",
    "any reminders I had set for tomorrow",
    "my tomorrow schedule",
    "give me my updated list with all reminders",
    "pull up my list",
    "whats on today",
  ]) assert.equal(isReadIntent(s), true, `should be a read: "${s}"`);

  for (const s of [
    "save the link",
    "add contact",
    "email khalid the new time",
    "set a meeting today 6pm",
    "6pm reminder to call malik",
    "football at 8pm, dalia meeting at 12pm",   // bare event mention = create, not read
    "delete the meeting",
    // COMPOUND read + action: a strong action verb anywhere vetoes the read, so a
    // fabricated "deleted" claim still reaches the rail (doctrine-review concern).
    "show me my list and delete the top task",
    "give me my updated list and add a task to call the bank",
  ]) assert.equal(isReadIntent(s), false, `should be an action: "${s}"`);
});

test("DOES NOT FIRE self-repair on a READ ask (the phantom-Malik-event guard)", () => {
  // The exact live shape: Jensen asked for his list, the model narrated a claim
  // with no tool. This MUST NOT be treated as an unbacked action claim.
  assert.equal(isUnbackedClaim("Done. Meeting with Malik is now on the calendar for today at 17:00.", NO_RUNS, "give me my updated list with all reminders"), false);
  assert.equal(isUnbackedClaim("You have the Dalia meeting set for 12:00 and football booked at 20:00.", NO_RUNS, "what are my meetings tomorrow"), false);
});

test("honestReply does NOT stub a schedule read that mentions set/booked times", async () => {
  const out = await honestReply("You have the Dalia meeting set for 12:00 and football booked at 20:00.", NO_RUNS, "what are my meetings tomorrow");
  assert.equal(out.startsWith("I have not done that yet"), false);
  assert.match(out, /Dalia/);
});
