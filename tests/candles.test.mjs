// The lineup on /candles/ (src/_data/candles.json). A new scent can go up before
// its label is drawn, so art is optional, but a scent always needs its words.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const candles = createRequire(import.meta.url)("../src/_data/candles.json");

test("every scent has a name and words, and any art it names exists", () => {
  for (const scent of candles.scents) {
    assert.ok(scent.name && scent.description, scent.slug);
    if (scent.art) assert.ok(existsSync(`src${scent.art}`), scent.art);
  }
  const slugs = candles.scents.map((scent) => scent.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});
