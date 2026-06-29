"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { app } = require("../src/server.js");

// RED-by-design baseline: against the un-modified server there is no rate
// limiting, so the 6th request still returns 401 (or 200) instead of 429.
// The live demo worker makes this pass by adding express-rate-limit:
// max 5 requests/min per IP on POST /api/login, returning 429 + Retry-After.
test("blocks the 6th login attempt from one IP with 429 + Retry-After", async () => {
  let lastResponse;

  for (let i = 0; i < 6; i += 1) {
    lastResponse = await request(app)
      .post("/api/login")
      .send({ username: "demo", password: "wrong" });
  }

  assert.equal(
    lastResponse.status,
    429,
    "6th request from one IP should be rate limited",
  );
  assert.ok(
    lastResponse.headers["retry-after"],
    "rate-limited response should carry a Retry-After header",
  );
});
