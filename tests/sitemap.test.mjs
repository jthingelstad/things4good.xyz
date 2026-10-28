// Sitemap <lastmod> (scripts/lastmod.cjs): the last commit touching a page's
// template or the data it prints, a W3C datetime, never the build time.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { DATA_SOURCES, lastmod } = createRequire(import.meta.url)("../scripts/lastmod.cjs");
const W3C_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

test("every page template has its data sources listed, and they exist", () => {
  const pages = readdirSync("src")
    .filter((name) => name.endsWith(".njk"))
    .map((name) => `src/${name}`)
    .filter((path) => !/eleventyExcludeFromCollections:\s*true/.test(readFileSync(path, "utf8")));
  assert.deepEqual(pages.sort(), Object.keys(DATA_SOURCES).sort());
  for (const files of Object.values(DATA_SOURCES)) for (const file of files) assert.ok(existsSync(file), file);
});

test("lastmod is the last commit touching the page and its data", () => {
  for (const [template, data] of Object.entries(DATA_SOURCES)) {
    const date = lastmod(`./${template}`);
    assert.match(date, W3C_DATETIME);
    const expected = execFileSync("git", ["log", "-1", "--format=%cI", "--", template, ...data], { encoding: "utf8" }).trim();
    assert.equal(date, expected);
  }
  assert.throws(() => lastmod("./src/unknown.njk"), /DATA_SOURCES/);
});
