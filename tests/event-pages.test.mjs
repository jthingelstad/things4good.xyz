// The per-event pages (src/event.njk) from metrics.eventPages. Their URLs go out
// in email, so a sale's address must not move, and none may land on another page.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { eventPages } = require("../src/_data/metrics.js");
const { events } = require("../src/_data/events.json");
const causes = require("../src/_data/causes.json");

test("every event has one page, a candle sale at its year", () => {
  for (const event of events) {
    const path = event.kind === "candle-sale" ? String(event.year) : event.slug;
    assert.equal(eventPages.filter((page) => page.path === path).length, 1, path);
  }
  const paths = eventPages.map((page) => page.path);
  assert.equal(new Set(paths).size, paths.length);
  const others = readdirSync("src").filter((name) => name.endsWith(".njk")).map((name) => name.replace(".njk", ""));
  for (const path of paths) {
    assert.match(path, /^[a-z0-9-]+$/, "the card maker takes only this shape");
    assert.ok(!others.includes(path), path);
  }
});

test("this year's picks hold a page with a slot per family member until they move to events.json", () => {
  const page = eventPages.find((p) => p.path === String(causes.year));
  const finished = events.some((e) => e.kind === "candle-sale" && e.year === causes.year);
  if (!causes.list.length && !finished) return assert.equal(page, undefined);
  if (finished) return assert.equal(page.upcoming, false);
  assert.equal(page.upcoming, true);
  assert.deepEqual(page.picks.map((p) => p.who), ["Jamie", "Tammy", "Mazie", "Tyler"]);
  for (const pick of causes.list) assert.ok(page.picks.includes(pick), pick.who);
});

test("past notes stay whole, not cut to fit a card", () => {
  const longest = Math.max(...events.flatMap((e) => e.supported.map((s) => s.reason.length)));
  assert.ok(longest > 230, "the Impact card's Read full note only shows past 230 characters");
});

test("every pick's logo is on disk and named for its slug", () => {
  for (const pick of causes.list) {
    assert.ok(existsSync(`src/images/logos/${pick.logo}`), pick.slug);
    assert.ok(pick.logo.startsWith(pick.slug), pick.slug);
  }
});
