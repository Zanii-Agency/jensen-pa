// FM-21: what reaches him when a calendar reminder fires. The cases are the real
// shape of his events; the assertions are the exact words he reads.
//
// Meta delivers free text only within 24h of his last message. Outside it the
// reminder must go as the approved template event_reminder_v1:
//   "Reminder. {{1}} at {{2}}. Reply here if you need anything for it."

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { reminderPlan, reminderTitle, REMINDER_TEMPLATE } from "../../lib/concierge/reminder-plan.ts";

const prateek = { title: "Meeting with Prateek", time: "19:00" };
const withLink = { title: "Call with Waren", time: "19:00", meeting_url: "https://meet.google.com/abc-defg-hij" };

test("he wrote in the last day: the normal text reminder, unchanged", () => {
  const p = reminderPlan(prateek, { open: true, hoursSince: 2 });
  assert.equal(p.mode, "text");
  assert.equal(p.text, "Reminder. Meeting with Prateek at 19:00.");
});

test("in the window, the join link still comes with the reminder", () => {
  const p = reminderPlan(withLink, { open: true, hoursSince: 5 });
  assert.equal(p.text, "Reminder. Call with Waren at 19:00.\nHere is your link to join: https://meet.google.com/abc-defg-hij");
});

test("quiet for 57h (the real 11 Sep Prateek case): the template, and the transcript records its exact words", () => {
  const p = reminderPlan(prateek, { open: false, hoursSince: 57 });
  assert.equal(p.mode, "template");
  assert.deepEqual(p.params, ["Meeting with Prateek", "19:00"]);
  assert.equal(p.text, "Reminder. Meeting with Prateek at 19:00. Reply here if you need anything for it.");
  assert.equal(REMINDER_TEMPLATE, "event_reminder_v1");
});

test("23h50 since his last message counts as closed: text could land after the window shuts", () => {
  assert.equal(reminderPlan(prateek, { open: true, hoursSince: 23.8 }).mode, "template");
  assert.equal(reminderPlan(prateek, { open: true, hoursSince: 23.4 }).mode, "text");
});

test("window unknown (database read failed): fail closed to the template, which always delivers", () => {
  assert.equal(reminderPlan(prateek, { open: false, hoursSince: Infinity }).mode, "template");
  assert.equal(reminderPlan(prateek, undefined).mode, "template");
});

test("his 'done' reply still finds the event: the logged words start with 'Reminder. <title> at'", () => {
  // pingedJustNow() in the webhook matches the latest reminder row by this prefix.
  for (const win of [{ open: true, hoursSince: 1 }, { open: false, hoursSince: 30 }]) {
    assert.ok(reminderPlan(prateek, win).text.startsWith(`Reminder. ${prateek.title} at`));
  }
});

test("Meta rejects newlines and tabs in template parameters: they are flattened", () => {
  const p = reminderPlan({ title: "Dinner\nwith  the\tteam", time: "20:30" }, { open: false, hoursSince: 40 });
  assert.deepEqual(p.params, ["Dinner with the team", "20:30"]);
});

test("off-window with a link: the template can't carry it, so the text fallback keeps it if Meta refuses the template", () => {
  const p = reminderPlan(withLink, { open: false, hoursSince: 30 });
  assert.equal(p.text, "Reminder. Call with Waren at 19:00. Reply here if you need anything for it.");
  assert.match(p.fallbackText, /meet\.google\.com/);
});

// Review of PR #12: what he reads, what is logged and what "done" looks for must
// be the same words, whatever the title looks like.
const messy = ["Call with Waren \u2014 Q3 review", "Lunch  with Nas", "Dinner with team ", "Dinner\nwith team", null, "\u2014"];

test("a title with a dash: no dash is logged or sent (Law 5), and the words match", () => {
  const off = reminderPlan({ title: "Call with Waren \u2014 Q3 review", time: "19:00" }, { open: false, hoursSince: 30 });
  assert.deepEqual(off.params, ["Call with Waren, Q3 review", "19:00"]);
  assert.equal(off.text, "Reminder. Call with Waren, Q3 review at 19:00. Reply here if you need anything for it.");
  const on = reminderPlan({ title: "Call with Waren \u2014 Q3 review", time: "19:00" }, { open: true, hoursSince: 1 });
  assert.equal(on.text, "Reminder. Call with Waren, Q3 review at 19:00.");
});

test("his 'done' still finds the event for untidy titles, on both paths", () => {
  for (const title of messy) for (const win of [{ open: true, hoursSince: 1 }, { open: false, hoursSince: 30 }]) {
    const p = reminderPlan({ title, time: "13:00" }, win);
    assert.ok(p.text.startsWith(`Reminder. ${reminderTitle(title)} at`), `${JSON.stringify(title)} ${p.mode}`);
  }
});

test("a title that is empty or only a dash never becomes an empty template parameter", () => {
  for (const title of [null, "", "  ", "\u2014"]) {
    const p = reminderPlan({ title, time: "13:00" }, { open: false, hoursSince: 30 });
    assert.equal(p.params[0], "Your event");
  }
});
