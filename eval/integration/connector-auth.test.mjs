// Connector bearer auth (Phase 4) — fail-closed security. The new ChatGPT door
// must never be open: unset/empty token denies, wrong token denies, only the exact
// token allows.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { bearerOk } from "../../lib/connector-auth.ts";

test("unset token denies everything (never allow-all)", () => {
  assert.equal(bearerOk("Bearer anything", undefined), false);
  assert.equal(bearerOk("Bearer anything", ""), false);
});

test("missing / empty header denies", () => {
  assert.equal(bearerOk(null, "secret"), false);
  assert.equal(bearerOk("", "secret"), false);
  assert.equal(bearerOk("Bearer ", "secret"), false);
});

test("wrong token denies", () => {
  assert.equal(bearerOk("Bearer nope", "secret"), false);
  assert.equal(bearerOk("Bearer secre", "secret"), false); // length-mismatch, no throw
  assert.equal(bearerOk("Bearer secrets", "secret"), false);
});

test("exact token allows (with or without the Bearer prefix)", () => {
  assert.equal(bearerOk("Bearer secret", "secret"), true);
  assert.equal(bearerOk("secret", "secret"), true);
});
