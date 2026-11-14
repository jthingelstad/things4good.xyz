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
  //
  // A card with `windows` (the order page) says what the page says in the
  // order window of this build (orders.js), keyed as order.njk keys its
  // heads: preorder, after, paused-sale, paused-count, closed. `orderFacts`
  // puts the order's own facts in the pills while it is open: the day it
  // closes, the price, and how the candles reach you.
  eleventyConfig.addFilter("cardFields", (card, site, orders) => {
    const shown = orders && orders.paused ? (orders.saleOn ? "paused-sale" : "paused-count") : orders && orders.window;
    const c = card.windows ? { photo: card.photo, ...card.windows[shown] } : card;
    const facts = c.saleFacts
      ? [site.saleDates, "Minneapolis", `$${site.pricePerCandle} a candle`]
      : c.orderFacts && orders.open
        ? [`Order by ${orders.closesDay}`, `$${site.pricePerCandle} a candle`, "Pickup or SPS delivery"]
        : [];
    return {
      kicker: c.kicker,
      name: c.name,
      accent: c.accent || "",
      summary: c.summary || "",
      photo: `https://things4good.xyz/images/cards/${c.photo}.jpg`,
      facts,
    };
  });
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

  // This year's pick for one family member, or nothing until it is announced
  // (causes.json). The picks can land a few at a time.
  eleventyConfig.addFilter("pickFor", (list, who) => list.find((c) => c.who === who));

  // An inline SVG QR code for a URL, drawn at build time so a print sign's
  // code follows its data (the causes sign points at this year's page). Ink on
  // white with a two-module quiet zone; the sign sets its size.
  eleventyConfig.addAsyncFilter("qrSvg", (url) =>
    require("qrcode").toString(url, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      color: { dark: "#2B2017", light: "#FFFFFF" },
    }),
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
