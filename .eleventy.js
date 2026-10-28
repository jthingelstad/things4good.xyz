const { createHash } = require("node:crypto");

const { lastmod } = require("./scripts/lastmod.cjs");

module.exports = function (eleventyConfig) {
  // A page's sitemap <lastmod>: the last commit touching its template or the
  // data it prints (scripts/lastmod.cjs).
  eleventyConfig.addFilter("lastmod", (inputPath) => lastmod(inputPath));

  // A page's share card (cards.thingelstad.com/t4g/...): what the card shows,
  // from the page's `card` front matter and the site's sale facts, and the
  // `v` that names that drawing, the first 10 hex of the SHA-256 of those
  // fields as JSON. base.njk publishes the fields as the page's h-entry.
  eleventyConfig.addFilter("cardFields", (card, site) => ({
    kicker: card.kicker,
    name: card.name,
    accent: card.accent || "",
    summary: card.summary || "",
    photo: `https://things4good.xyz/images/cards/${card.photo}.jpg`,
    facts: card.saleFacts ? [site.saleDates, "Minneapolis", `$${site.pricePerCandle} a candle`] : [],
  }));
  eleventyConfig.addFilter("cardVersion", (f) =>
    createHash("sha256")
      .update(JSON.stringify([f.kicker, f.name, f.accent, f.summary, f.photo, ...f.facts]))
      .digest("hex")
      .slice(0, 10),
  );

  // `?v=` for a passthrough asset: the first 10 hex of its SHA-256, so a
  // browser holding last deploy's copy fetches the new one (browsers keep
  // files five minutes, scripts/publish-plan.mjs).
  eleventyConfig.addFilter("assetVersion", (file) =>
    createHash("sha256").update(require("node:fs").readFileSync(`src/${file}`)).digest("hex").slice(0, 10),
  );

  // Copy the stylesheet straight through to the site root.
  eleventyConfig.addPassthroughCopy({ "src/styles.css": "styles.css" });

  // Copy the browser favicon to the site root.
  eleventyConfig.addPassthroughCopy("src/favicon.svg");

  // Copy robots.txt to the site root.
  eleventyConfig.addPassthroughCopy("src/robots.txt");

  // Copy image assets you drop in src/images straight through to /images.
  eleventyConfig.addPassthroughCopy("src/images/**/*.{jpg,jpeg,png,gif,webp,svg,avif,ico}");

  // The images README is repo documentation only — don't publish it.
  eleventyConfig.ignores.add("src/images/README.md");

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
