# AGENTS.md — things4good.xyz

This file provides guidance to coding agents (Claude Code, Codex) when working with code in this repository. `CLAUDE.md` is a symlink to this file.

## What this is

Marketing site for **Things 4 Good** — the Thingelstad family's annual handmade-candle fundraiser. It is a static [Eleventy](https://www.11ty.dev/) v3 build on `things4good.xyz`, moving from GitHub Pages to S3 and CloudFront (see "Deploy"; both publish every push until the DNS cutover). There is no backend, no client framework, and no build step beyond Eleventy itself.

Pages, each a `src/*.njk` that extends `base.njk` (Eleventy emits `<name>/index.html`, served at `/<name>/`):
- `index.njk` — long-scroll home page (the only one at `/`)
- `maker-night.njk` — Maker Night event page. Gated by `site.makerNight`: when `false` (2026, no Maker Night this year) the page still builds at `/maker-night/` but every link to it (nav, footer, home teaser, FAQ question) is hidden, it carries `noindex`, and it is left out of `sitemap.xml`. Flip the toggle to `true` to bring it all back (and refresh the "New for 2026" copy).
- `impact.njk` — filterable/sortable list of every nonprofit supported (client-side, from `metrics.nonprofits`; filters by picker + event)
- `stats.njk` — cumulative "by the numbers" page
- `preorder.njk` — preorder steps + payment methods
- `faq.njk` — standalone FAQ
- `404.njk` — `/404.html`, which CloudFront (and GitHub Pages, until the cutover) serves with a 404 for any path the site lacks; `noindex` and out of the sitemap.
- `llms.txt.njk` — `/llms.txt`, the site for agents and LLMs: the fundraiser, the pages, every sale and every nonprofit, all from `metrics` (plain text, so values go out with `| safe`). `base.njk` links it from every page; it stays out of `collections.all` and the sitemap. No feed, by Jamie's call.

## Commands

```bash
npm start    # eleventy --serve — dev server with live reload
npm run build # eleventy — one-off build into _site/
npm run clean # rm -rf _site
```

```bash
npm test          # the hosting: viewer-request function, content types, caching, committed templates
npm run test:e2e  # after a build: every file in _site/ has a content type the S3 deploy chose for it
```

There is no linter, and nothing tests the pages themselves. Verification is visual — run `npm start` and look at the page.

## Architecture

Eleventy config lives in `.eleventy.js`. Key conventions it sets:
- Input is `src/`, output is `_site/` (git-ignored). Includes in `src/_includes`, data in `src/_data`.
- Both HTML and Markdown render through **Nunjucks** (`htmlTemplateEngine` / `markdownTemplateEngine` are `njk`).
- `base.njk` links `/styles.css?v=<hash>` (the `assetVersion` filter), because browsers keep the stylesheet a while (ten minutes on GitHub Pages, five on CloudFront, `scripts/publish-plan.mjs`). Without the hash, a fresh page arrived with last deploy's stylesheet and the candles drew as bare grey buttons (10-25). CloudFront's cache key ignores the query, so the hash only steers browsers; each deploy clears CloudFront.
- `src/styles.css`, `src/favicon.svg`, `src/CNAME`, and anything under `src/images/` are passthrough-copied to the site root unchanged (`CNAME` is for GitHub Pages; the S3 deploy leaves it out). `src/images/README.md` is explicitly ignored from the build.

### Templating

`src/_includes/base.njk` is the single layout. Every page does `{% extends "base.njk" %}` and fills named blocks rather than passing a `layout:` in front matter. The blocks the base exposes: `head` (extra `<head>` tags), `brandHref`, `navLinks`, `navDate`, `navCta`, `content`, `footerExplore`, `subscribeHref`, `scripts`. Page front matter sets `title` and `description` (both consumed by `<head>`); the canonical link and the share tags (Open Graph, a large Twitter card) are built from those and `page.url`, so a page never sets them.

**Share cards.** A page with a `card` in its front matter shares a card drawn by cards.thingelstad.com (2026-10-25, Jamie's direction B: the site's own type over a candle photo, the band naming the family). `card` holds `kicker` (the page's eyebrow), `name` (its heading), `accent` (the heading's last words, set apart: "100% for good."), `summary` (a line under it), `photo` (a file in `src/images/cards/`, cut to 1200 x 562, the card's photo area; the card maker fetches no other photo) and `saleFacts: true` for the sale's date, city and price as pills, from `site.json`. `base.njk` publishes those as the page's h-entry (`<data>` elements at the end of `<main>`, which is all the card reads) and points `og:image` at `https://cards.thingelstad.com/t4g/<page>.png?v=<v>` (`index` for the home page), with `v` the first 10 hex of the SHA-256 of the fields (the `cardFields` and `cardVersion` filters in `.eleventy.js`), so changing what the card says draws a new card. No running totals on a card: they change. A page without `card` (Maker Night, the 404) keeps the plain candle photo. The card maker's side is `~/Projects/thingelstad.com/cards.thingelstad.com` (its `t4g` entry); a new card field needs it there first.

**The nav and footer are canonical defaults in `base.njk`** — `navLinks` (Fundraiser · Impact · Numbers · Maker Night when `site.makerNight` · FAQ), `navDate` (`site.saleDates`), `navCta` (the Get updates button, to the Buttondown list), and `footerExplore` (6-item list) all have real default content. Pages inherit them automatically; a page overrides a block only to deviate — typically `navLinks` to add `aria-current="page"` on its own item, or `brandHref`/`navCta` for page-specific behavior. Subpages set `brandHref` to `/`; the home page keeps the default `#top`. When changing site-wide nav/footer, edit the defaults in `base.njk`, not each page.

`base.njk` also contains the only JavaScript on the site, inline near the bottom: an animated number counter (driven by `data-target` on `#counter`) and an `IntersectionObserver` that adds visibility to elements with the `.reveal` class on scroll. Tinylytics analytics loads only if `site.tinylyticsEmbed` is set.

**Tinylytics kudos and events** (2026-10-25, Jamie's go). The embed URL in `site.json` carries `?events&auto&kudos=custom`.
- *Kudos:* every card on `/impact/` has a candle button, a plain pill of a flame and a count (Jamie, 10-25: "keep the design to a simple button with a counter"). Its title and aria-label say "Light a candle for <name>". It is a Tinylytics kudos with `data-path="/impact/<slug>/"`, the path the designed-for per-org pages would take, so each nonprofit keeps one count across years.
  - The embed writes only the count into the button, so the flame is drawn by CSS (`.candle-kudos::before`, Lucide's flame as a mask): an outline until this browser lights it (`.did_select`), then filled.
  - The button starts with the text `0`. The count endpoint answers only for paths that already have a kudo, and the embed leaves the button's text alone otherwise.
  - The embed wires kudos buttons once, when the page loads. That is why the Impact script draws every card once and filters by hiding and reordering them. Never go back to rebuilding the grid's HTML, or the candles go dead after the first filter change.
- *Events:* auto mode counts outbound links (`link.outbound`, value = host). Hand-tagged events, via `data-tinylytics-event` + `data-tinylytics-event-value`:
  - `updates.click`: every Get updates link. The value names the spot (`nav`, `footer`, `home-hero`, `home-when`, `home-lineup`, `home-subscribe`, `impact-close`, `faq-when`, `faq-ask`, `preorder-steps`, `preorder-close`).
  - `nonprofit.visit`: the value is the org slug.
  - `preorder.sheet`: the value is where the link sits.
  - `chart.year`: the home and Numbers year links. The value is the year.
  - `faq.open`: the value is a question key. A small script in `faq.njk` keeps the event on closed questions only, so closing one is not counted.
  - A new subscribe link gets an `updates.click` tag with a new spot name. A tagged link is not also counted as `link.outbound`.
  - Everything is anonymous and counted per click, never per person.

### Content is data-driven — events → supported nonprofits, everything else computed

The model is **sale events, each allocating its exact total to a set of nonprofits**. There is one hand-edited dataset of events plus a small config file; every total, count, growth rate, chart height, grand total, and candle-math figure is *derived* in `metrics.js`. **Never hardcode a derived number in a template, and never duplicate event/org facts** — that's the mistake this layer was built to prevent (the home and stats charts had already drifted apart).

- **`events.json`** — the single source of truth: `events[]`, one record per sale event. Fields: `slug`, `kind` (exactly `"candle-sale"` or `"special-event"`), `year`, `name`, exact `raised` total, and (candle-sale only) `candles` + `participants`. Each event nests `supported[]` — its nonprofit allocations: `slug` (stable org key, matches the logo filename), `name`, `logo`, `url`, `who` (family-member picker, or `"Everyone"` for collective/special-event recipients), `amount` (estimate), `blurb`, `reason` (`""` when none). The annual **candle sale** is the only `kind` that splits across multiple nonprofits; **special events** (the holiday market, Maker Night) each support one. Per-nonprofit `amount`s are estimates tuned to sum to the event's exact `raised`; only the event total is exact. No `*Estimate` flags — the `(est.)` markers are static template text.
- **`metrics.js`** (computed, CommonJS) — `require()`s `events.json` + `site.json` and exports the `metrics` global. Candle-sale events drive `perYear[]` (`cumulative`, `growthPct`/`Display`, stacked-bar `candleHeightPct`/`eventsHeightPct`/`barHeightPct`, `yearTotal`, `isLatest`, `slug`) — **cumulative & growth are candle-sale only**; special events add only the stacked segment + the grand total. Also exports `totalRaised` (candle), `eventsTotal`, `grandTotal` (+`Display`s), `nonprofits` (flattened allocations enriched with `year`/`eventKind`/`eventName`/`event`, feeds the Impact list + home logo-wall), `eventList` (Impact event filter), `orgCount`, `records`, `candleMath`, `raisedStats`, `footStats`, `pricePerCandle`. **All display formatting is done here via `toLocaleString`, so templates stay dumb** — no number filters in `.eleventy.js`.
- **`site.json`** — true global config: `name`, `email`, `saleDates`, `saleYear`, `makers[]`, `blogUrl`, feature toggles (`preorderSheet`, `tinylyticsEmbed`, `makerNight`), plus the candle-sale constants moved out of the event data: `pricePerCandle`, `candleConstants` (wax/wick/burn per candle), `tightestRace`.

To change fundraiser facts you almost always edit `events.json` (or `site.json` for constants) and rebuild. A new fundraising occasion is a new event object; record Maker Night results by adding a `kind:"special-event"` event for the year. Note some JSON/JS string values carry HTML entities (`&amp;`, `&middot;`) rendered with `| safe` — keep that style. Gotcha: during `eleventy --serve`, editing the JSON re-runs `metrics.js` on rebuild; if numbers ever look stale, restart `npm start`.

**Future per-org pages** (`/impact/<slug>/`) are designed-for but not built: add a `src/organization.njk` paginating over `metrics.nonprofits` (`size: 1`, `permalink: "/impact/{{ org.slug }}/"`); the `slug` field already exists for this.

### Styling

A single hand-written `src/styles.css` (~480 lines), no preprocessor or utility framework. Design tokens (color names like `--marigold`, `--pine`) are CSS custom properties. Fonts (Newsreader, Hanken Grotesk, Caveat) load from Google Fonts in the `<head>`.

## Deploy

`.github/workflows/deploy.yml` tests and builds with Node 24 on every pull request and push. A push to `main` publishes the same build twice, to GitHub Pages (pinned to the domain by `src/CNAME`) and, in the `deploy-aws` job, to S3 and CloudFront. There is no staging environment — `main` is production.

### S3 and CloudFront

The site is moving from GitHub Pages to S3 and CloudFront (Jamie, 2026-10-27: "Approved: move things4good.xyz, poapkings.com and rwbookclub.com from GitHub Pages to S3 + CloudFront"), copying the shape escape.thingelstad.com took on 2026-10-26. Pages keeps deploying until Jamie moves the DNS; retiring it (the Pages job, `src/CNAME`, the Pages setting) is a follow-up after the cutover.

Three stacks, generated by `infra/templates.mjs` into `infra/generated/` (`npm run infra:generate`; a unit test fails when the committed JSON is stale) and deployed **from this Mac as the cloud-engineer identity** with `npm run infra -- certificate|site|delivery` (`--plan` prints the change set and stops). `infra/deployment.json` records their names, tags (`Project=things4good`) and outputs.

- `things4good-certificate`: one ACM certificate for `things4good.xyz` and `www.things4good.xyz`, validated by two CNAMEs at Namecheap (`npm run infra -- certificate` prints both, and again on a rerun). DNS is Jamie's to edit. Keep both records: renewal needs them. ACM checks CAA along each name's CNAME chain, and GitHub's CAA refuses Amazon, so `www` cannot validate while it is a CNAME to `jthingelstad.github.io`; the apex (A records, no CAA) can.
- `things4good-site`: a private, versioned bucket (old versions kept 90 days) behind CloudFront with origin access control; AWS's CachingOptimized policy (no query string in the key, so `?ref=` and `?v=` share one copy); security headers plus `Access-Control-Allow-Origin: *` as Pages sent; 403/404 serve `/404.html`; access logs to CloudWatch Logs (`/things4good/web-access`, 14 days, JSON, no viewer IP and no query string); a 5xx alarm to `weekly-thing-librarian-alarms`. The aliases (apex and www) and the certificate attach only once the certificate is ISSUED (rerun `npm run infra -- site`).
- `things4good-delivery`: the role GitHub Actions assumes (`vars.AWS_DEPLOY_ROLE_ARN`), `main` only. It can publish into the bucket and clear the cache; it cannot change the stacks.

The viewer-request function (`infra/viewer-request.mjs`) sends any `www.` host to the apex with one 301 that keeps the path (in its slash form) and the query string, sends a bare path to its slash form, and serves `index.html` for directory URLs. There is no redirect map.

**Content types and caching** are set per file by `scripts/publish-plan.mjs`: every file is five minutes in browsers and a day in CloudFront, which every deploy clears. `tests/e2e/built-site.cjs` (`npm run test:e2e`, after `npm run build`) fails when the build writes a file the table does not type, so a new kind of file needs an entry there.

`npm run deploy:aws` (`scripts/deploy-aws.mjs`) refuses unless the site stack's live template equals `infra/generated/site.json`, so infrastructure goes out first, on its own. It uploads the files whose MD5 changed (`--all` re-uploads everything, needed after a `publish-plan.mjs` change), deletes what the build no longer writes, clears the cache, and reads the result back through the CloudFront domain (the front page as built, a deep page, the stylesheet's and sitemap's types, the slash form, a 404). The deploy assumes the delivery role through GitHub's OIDC token; no AWS keys are stored.
