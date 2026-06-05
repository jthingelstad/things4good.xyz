# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Marketing site for **Things 4 Good** — the Thingelstad family's annual handmade-candle fundraiser. It is a static [Eleventy](https://www.11ty.dev/) v3 build deployed to GitHub Pages on `things4good.xyz`. There is no backend, no client framework, and no build step beyond Eleventy itself.

Pages, each a `src/*.njk` that extends `base.njk` (Eleventy emits `<name>/index.html`, served at `/<name>/`):
- `index.njk` — long-scroll home page (the only one at `/`)
- `maker-night.njk` — Maker Night event page
- `impact.njk` — filterable/sortable list of every nonprofit supported (client-side, from `metrics.nonprofits`; filters by picker + event)
- `stats.njk` — cumulative "by the numbers" page
- `preorder.njk` — preorder steps + payment methods
- `faq.njk` — standalone FAQ

## Commands

```bash
npm start    # eleventy --serve — dev server with live reload
npm run build # eleventy — one-off build into _site/
npm run clean # rm -rf _site
```

There is no linter or test suite. Verification is visual — run `npm start` and look at the page.

## Architecture

Eleventy config lives in `.eleventy.js`. Key conventions it sets:
- Input is `src/`, output is `_site/` (git-ignored). Includes in `src/_includes`, data in `src/_data`.
- Both HTML and Markdown render through **Nunjucks** (`htmlTemplateEngine` / `markdownTemplateEngine` are `njk`).
- `src/styles.css`, `src/favicon.svg`, `src/CNAME`, and anything under `src/images/` are passthrough-copied to the site root unchanged. `src/images/README.md` is explicitly ignored from the build.

### Templating

`src/_includes/base.njk` is the single layout. Every page does `{% extends "base.njk" %}` and fills named blocks rather than passing a `layout:` in front matter. The blocks the base exposes: `brandHref`, `navLinks`, `navDate`, `navCta`, `content`, `footerExplore`, `subscribeHref`, `scripts`. Page front matter sets only `title` and `description` (both consumed by `<head>`).

**The nav and footer are canonical defaults in `base.njk`** — `navLinks` (The Sale · Maker Night · Impact · Stats · FAQ), `navDate` (`site.saleDates`), `navCta` (the Preorder button), and `footerExplore` (6-item list) all have real default content. Pages inherit them automatically; a page overrides a block only to deviate — typically `navLinks` to add `aria-current="page"` on its own item, or `brandHref`/`navCta` for page-specific behavior. Subpages set `brandHref` to `/`; the home page keeps the default `#top`. When changing site-wide nav/footer, edit the defaults in `base.njk`, not each page.

`base.njk` also contains the only JavaScript on the site, inline near the bottom: an animated number counter (driven by `data-target` on `#counter`) and an `IntersectionObserver` that adds visibility to elements with the `.reveal` class on scroll. Tinylytics analytics loads only if `site.tinylyticsEmbed` is set.

### Content is data-driven — events → supported nonprofits, everything else computed

The model is **sale events, each allocating its exact total to a set of nonprofits**. There is one hand-edited dataset of events plus a small config file; every total, count, growth rate, chart height, grand total, and candle-math figure is *derived* in `metrics.js`. **Never hardcode a derived number in a template, and never duplicate event/org facts** — that's the mistake this layer was built to prevent (the home and stats charts had already drifted apart).

- **`events.json`** — the single source of truth: `events[]`, one record per sale event. Fields: `slug`, `kind` (exactly `"candle-sale"` or `"special-event"`), `year`, `name`, exact `raised` total, and (candle-sale only) `candles` + `participants`. Each event nests `supported[]` — its nonprofit allocations: `slug` (stable org key, matches the logo filename), `name`, `logo`, `url`, `who` (family-member picker, or `"Everyone"` for collective/special-event recipients), `amount` (estimate), `blurb`, `reason` (`""` when none). The annual **candle sale** is the only `kind` that splits across multiple nonprofits; **special events** (the holiday market, Maker Night) each support one. Per-nonprofit `amount`s are estimates tuned to sum to the event's exact `raised`; only the event total is exact. No `*Estimate` flags — the `(est.)` markers are static template text.
- **`metrics.js`** (computed, CommonJS) — `require()`s `events.json` + `site.json` and exports the `metrics` global. Candle-sale events drive `perYear[]` (`cumulative`, `growthPct`/`Display`, stacked-bar `candleHeightPct`/`eventsHeightPct`/`barHeightPct`, `yearTotal`, `isLatest`, `slug`) — **cumulative & growth are candle-sale only**; special events add only the stacked segment + the grand total. Also exports `totalRaised` (candle), `eventsTotal`, `grandTotal` (+`Display`s), `nonprofits` (flattened allocations enriched with `year`/`eventKind`/`eventName`/`event`, feeds the Impact list + home logo-wall), `eventList` (Impact event filter), `orgCount`, `records`, `candleMath`, `raisedStats`, `footStats`, `pricePerCandle`. **All display formatting is done here via `toLocaleString`, so templates stay dumb** — no number filters in `.eleventy.js`.
- **`site.json`** — true global config: `name`, `email`, `saleDates`, `saleYear`, `makers[]`, `blogUrl`, feature toggles (`preorderSheet`, `tinylyticsEmbed`), plus the candle-sale constants moved out of the event data: `pricePerCandle`, `candleConstants` (wax/wick/burn per candle), `tightestRace`.

To change fundraiser facts you almost always edit `events.json` (or `site.json` for constants) and rebuild. A new fundraising occasion is a new event object; record Maker Night results by adding a `kind:"special-event"` event for the year. Note some JSON/JS string values carry HTML entities (`&amp;`, `&middot;`) rendered with `| safe` — keep that style. Gotcha: during `eleventy --serve`, editing the JSON re-runs `metrics.js` on rebuild; if numbers ever look stale, restart `npm start`.

**Future per-org pages** (`/impact/<slug>/`) are designed-for but not built: add a `src/organization.njk` paginating over `metrics.nonprofits` (`size: 1`, `permalink: "/impact/{{ org.slug }}/"`); the `slug` field already exists for this.

### Styling

A single hand-written `src/styles.css` (~480 lines), no preprocessor or utility framework. Design tokens (color names like `--marigold`, `--pine`) are CSS custom properties. Fonts (Newsreader, Hanken Grotesk, Caveat) load from Google Fonts in the `<head>`.

## Deploy

`.github/workflows/` builds with Node 24 and deploys `_site/` to GitHub Pages on every push to `main`. The custom domain is pinned by `src/CNAME`. There is no staging environment — `main` is production.
