// A page's sitemap <lastmod>: the committer date (ISO 8601 with offset, a W3C
// datetime) of the newest commit that touched the page's template or the data
// it prints. Never the build time: Google ignores lastmod on a site where it
// is always "now". base.njk (shared chrome) is left out on purpose.
//
// The dates come from git history, so a shallow clone (every file dated to its
// one commit) fails the build instead; CI checks out with fetch-depth: 0.
const { execFileSync } = require("node:child_process");

// The data files each page prints, beside its own template. metrics.js
// derives everything from events, saleStats and site, so a page that prints
// `metrics.*` depends on all four. Kept here, not in front matter, so adding a
// page's entry never bumps that page's own date.
const SITE = ["src/_data/site.json"];
const METRICS = ["src/_data/metrics.js", "src/_data/events.json", "src/_data/saleStats.json", ...SITE];
const DATA_SOURCES = {
  "src/index.njk": METRICS,
  "src/faq.njk": METRICS,
  "src/impact.njk": METRICS,
  "src/stats.njk": METRICS,
  "src/maker-night.njk": METRICS,
  "src/preorder.njk": SITE,
};

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function lastmod(inputPath, cwd = process.cwd()) {
  if (git(["rev-parse", "--is-shallow-repository"], cwd) === "true") {
    throw new Error("sitemap lastmod comes from git history, which a shallow clone lacks (fetch-depth: 0)");
  }
  const template = inputPath.replace(/^\.\//, "");
  if (!DATA_SOURCES[template]) throw new Error(`sitemap lastmod: add ${template} to DATA_SOURCES in scripts/lastmod.cjs`);
  const files = [template, ...DATA_SOURCES[template]];
  const date = git(["log", "-1", "--format=%cI", "--", ...files], cwd);
  if (!date) throw new Error(`sitemap lastmod: no commit touches ${files.join(", ")}`);
  return date;
}

module.exports = { DATA_SOURCES, lastmod };
