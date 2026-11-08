// Browser tests for /order/, opt-in: `npm run test:browsers` builds the site and runs this. Never in CI
// (Jamie, 2026-11-04: browser tests run only when they are specifically needed), so `npm test` and the
// deploy workflow leave it alone: node's default test globs don't reach tests/browsers/.
//
// The built page is served from _site by a server in this process, with the order service stubbed in
// the same process and Turnstile running for real on Cloudflare's test keys. Nothing reaches Grist,
// Buttondown or the live Turnstile widget. The stub answers from stock.json, /api/stock as read on
// 2026-11-07, so the product ids below are that sale's.
//
//   npm run test:browsers                          every engine and size below except chrome
//   BROWSERS=webkit,iphone15 npm run test:browsers  just those
//   SCENARIOS=happy|layout npm run test:browsers    scenarios whose name matches the regex
//   SHOTS=/tmp/shots npm run test:browsers          also save screenshots of the form and the widget
//
// Needs the browsers once: `npx playwright install chromium firefox webkit`. `chrome` is the installed
// Google Chrome, so it runs only when named.
//
// Known gaps: emulated phones can't send keystrokes the way a phone keyboard does, so the keyboard
// scenario is desktop only; desktop WebKit tabs past radios and checkboxes unless Option-Tab is used,
// as Safari does by default, so the scenario uses Alt+Tab there.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pw = require('playwright');

const REPO = path.join(__dirname, '..', '..');
const SITE = path.join(REPO, '_site');
const SITE_KEY = JSON.parse(fs.readFileSync(path.join(REPO, 'src/_data/site.json'), 'utf8')).turnstileSiteKey;
const KEYS = { pass: '1x00000000000000000000AA', fail: '2x00000000000000000000AB', interactive: '3x00000000000000000000FF' };
const STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, 'stock.json'), 'utf8'));
const CAUSES = JSON.parse(fs.readFileSync(path.join(REPO, 'src/_data/causes.json'), 'utf8')).list;
const EMAIL = 'jamie@thingelstad.com';
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ---- the stub server -------------------------------------------------------------------------
// Each browser context carries a cookie naming its scenario, so scenarios run side by side.
const scenarios = new Map();
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.xml': 'application/xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const next = (list) => (list.length > 1 ? list.shift() : list[0]);
function answer(res, step) {
  setTimeout(() => {
    res.writeHead(step.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(step.body ?? {}));
  }, step.delay || 0);
}
const server = http.createServer((req, res) => {
  const id = /(?:^|;\s*)scn=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const scn = scenarios.get(id);
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    if (!scn) { res.writeHead(400); return res.end('no scenario cookie'); }
    if (url.pathname === '/api/stock' && req.method === 'GET') { scn.log.stock.push(Date.now()); return answer(res, next(scn.stock)); }
    if (url.pathname === '/api/order' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        scn.log.order.push({ at: Date.now(), type: req.headers['content-type'], hashOk: crypto.createHash('sha256').update(raw).digest('hex') === req.headers['x-amz-content-sha256'], json });
        answer(res, next(scn.order));
      });
      return;
    }
    res.writeHead(405); return res.end();
  }
  let file = path.join(SITE, decodeURIComponent(url.pathname));
  if (file.endsWith('/')) file += 'index.html';
  else if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file += '/index.html';
  if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(SITE, '404.html'))); }
  let body = fs.readFileSync(file);
  if (file.endsWith('.html') && scn) {
    // The test key for the scenario, and an open build window whatever site.json says today, so the
    // page asks the stub for stock (a shut build never calls the service). The stub's window wins.
    body = Buffer.from(body.toString('utf8').replaceAll(SITE_KEY, KEYS[scn.key || 'pass']).replace(/const BUILT = "[a-z]+";/, 'const BUILT = "preorder";'));
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});

// ---- helpers -----------------------------------------------------------------------------------
const ok = (body) => ({ status: 200, body });
const stockOf = (mutate) => { const s = structuredClone(STOCK); if (mutate) mutate(s); return [ok(s)]; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = { trueNorth: 3, winter: 2, lid: 16, golden: 15, tnXL: 14, wwXL: 13, apple: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tools(page, scn, t) {
  const more = async (id, n = 1) => { for (let i = 0; i < n; i++) await page.click(`[data-product="${id}"] [data-more]`); };
  const less = (id) => page.click(`[data-product="${id}"] [data-less]`);
  const ready = () => page.waitForSelector('#order-form:not([hidden]) [data-more]', { timeout: 20000 });
  const fill = async (o = {}) => {
    await page.fill('input[name=name]', o.name ?? 'Testy McTest');
    await page.fill('input[name=email]', o.email ?? 'testy@example.com');
    await page.fill('input[name=mobile]', o.mobile ?? '(612) 555-0100');
  };
  const errorText = () => page.evaluate(() => { const e = document.getElementById('order-error'); return e.hidden ? '' : e.textContent; });
  const waitError = async (timeout = 25000) => {
    try { await page.waitForFunction(() => { const e = document.getElementById('order-error'); return !e.hidden && e.textContent; }, null, { timeout }); } catch {}
    return errorText();
  };
  const waitDone = async (timeout = 30000) => {
    try { await page.waitForSelector('#order-done:not([hidden])', { timeout }); return true; } catch { return false; }
  };
  const doneInfo = () => page.evaluate(() => ({
    title: document.getElementById('order-done-title').textContent,
    total: document.getElementById('order-done-total').textContent,
    causes: document.getElementById('order-done-causes').hidden ? null : document.getElementById('order-done-causes').textContent,
    next: document.getElementById('order-done-next').textContent,
    items: [...document.querySelectorAll('#order-done-items li')].map((li) => li.textContent),
    focused: document.activeElement && document.activeElement.id,
    formHidden: document.getElementById('order-form').hidden,
  }));
  const qty = (id) => page.textContent(`[data-product="${id}"] output`);
  const note = (id) => page.textContent(`[data-product="${id}"] .order-left`);
  const moreDisabled = (id) => page.isDisabled(`[data-product="${id}"] [data-more]`);
  const total = () => page.textContent('#order-total');
  const tokenReady = () => page.waitForFunction(() => { const i = document.querySelector('#order-check input[name="cf-turnstile-response"]'); return i && i.value; }, null, { timeout: 20000 }).then(() => true, () => false);
  const boxShows = () => page.waitForFunction(() => document.getElementById('order-check').getBoundingClientRect().height > 30, null, { timeout: 20000 }).then(() => true, () => false);
  const hint = () => page.evaluate(() => { const h = document.getElementById('order-check-hint'); return h.getBoundingClientRect().height ? h.textContent : ''; });
  const waitHint = async () => { await page.waitForFunction(() => document.getElementById('order-check-hint').textContent, null, { timeout: 20000 }).catch(() => {}); return hint(); };
  const expect = (name, cond, detail) => t.checks.push({ name, ok: !!cond, detail: cond ? undefined : detail });
  const eq = (name, got, want) => expect(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  const remark = (s) => t.notes.push(s);
  return { more, less, ready, fill, errorText, waitError, waitDone, doneInfo, qty, note, moreDisabled, total, tokenReady, boxShows, hint, waitHint, expect, eq, remark, orders: () => scn.log.order };
}

const causeName = (g) => CAUSES.find((c) => c.grist === g).name;
const ALL = CAUSES.map((c) => c.grist);
const HINT = 'Check the box above so we know you’re not a bot.';
const MSG = {
  allCauses: 'It’s divided evenly across this year’s causes.',
  nextPreorder: 'Pick them up anytime during the sale. Jamie will email you the details.',
  nextSps: 'Jamie will get them to you at work.',
  nextAfter: 'Jamie will email you the pickup details.',
  wrong: `Something went wrong on our end. Press Place order again: it won’t double up. Or email ${EMAIL}.`,
  notYet: 'Our spam check isn’t done yet. If a box shows above the button, check it, then press Place order again.',
};

// ---- scenarios ---------------------------------------------------------------------------------
// Each one: { stock, order, key, block, init, causes, layout, run(x, page, t) }. `layout` ones also run
// on the extra sizes. `causes` ones need this year's four causes in causes.json.
const S = {};

S.happy = { order: [ok({ ok: true, total: 110 })], async run(x, page) {
  await x.ready();
  const groups = await page.$$eval('#order-products h2', (h) => h.map((e) => e.textContent));
  x.eq('groups in order', groups, ['Candles', 'XL candles', 'Candle lids', 'Maker Night']);
  x.eq('17 rows', (await page.$$('.order-row')).length, 17);
  x.expect('art drawn for scents', (await page.$$eval('.order-art img', (i) => i.length)) >= 12, 'few images');
  x.expect('submit disabled while empty', await page.isDisabled('#order-submit'), 'enabled');
  await x.more(ID.trueNorth, 2); await x.more(ID.wwXL); await x.more(ID.lid);
  x.eq('total', await x.total(), '$110');
  x.eq('summary', await page.$$eval('#order-summary li', (l) => l.map((e) => e.textContent)), ['2 × True North$50', '1 × Candle Lid$10', '1 × Winter Wonderland XL$50']);
  await x.fill({ name: '  Testy McTest  ' });
  await page.check('input[value="SPS delivery"]');
  await page.fill('textarea[name=note]', 'Gift for "Mom" 🎁\nThanks — really!');
  if (CAUSES.length) x.expect('all causes checked at start', await page.$$eval('input[name=causes]', (b, n) => b.length === n && b.every((e) => e.checked), CAUSES.length), 'not all checked');
  x.expect('turnstile token arrives', await x.tokenReady(), 'no token in 20 s');
  x.eq('no check-the-box hint when no box shows', await x.hint(), '');
  await page.click('#order-submit');
  x.expect('done screen', await x.waitDone(), `no done; error: ${await x.errorText()}`);
  const o = x.orders();
  x.eq('one request', o.length, 1);
  const b = o[0]?.json || {};
  x.expect('sha256 header matches body', o[0]?.hashOk, 'hash mismatch');
  x.expect('json content type', /application\/json/.test(o[0]?.type || ''), o[0]?.type);
  x.expect('request id is a uuid', UUID.test(b.requestId || ''), b.requestId);
  x.eq('turnstile token is the test token', b.turnstile, 'XXXX.DUMMY.TOKEN.XXXX');
  x.eq('items', b.items, [{ product: ID.trueNorth, quantity: 2 }, { product: ID.wwXL, quantity: 1 }, { product: ID.lid, quantity: 1 }].sort((a, c) => STOCK.products.findIndex((p) => p.id === a.product) - STOCK.products.findIndex((p) => p.id === c.product)));
  if (CAUSES.length) x.eq('causes sent', b.causes, ALL);
  x.eq('name trimmed', b.name, 'Testy McTest');
  x.eq('fulfillment', b.fulfillment, 'SPS delivery');
  x.eq('note kept', b.note, 'Gift for "Mom" 🎁\nThanks — really!');
  x.eq('trap empty', b.website, '');
  const d = await x.doneInfo();
  x.eq('done title', d.title, 'Your order is in, Testy McTest.');
  x.eq('done total', d.total, '$110');
  if (CAUSES.length) x.eq('done causes', d.causes, MSG.allCauses);
  x.eq('done next', d.next, MSG.nextSps);
  x.eq('done has focus', d.focused, 'order-done');
  x.expect('form hidden', d.formHidden, 'form still showing');
} };

S.twoCauses = { causes: true, order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  const boxes = page.locator('input[name=causes]');
  await boxes.nth(0).uncheck(); await boxes.nth(3).uncheck();
  await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.eq('causes sent', x.orders()[0]?.json?.causes, [ALL[1], ALL[2]]);
  const d = await x.doneInfo();
  x.eq('done causes', d.causes, `It’s divided evenly across ${causeName(ALL[1])} and ${causeName(ALL[2])}.`);
  x.eq('done next (pickup, preorder)', d.next, MSG.nextPreorder);
  x.eq('fulfillment default', x.orders()[0]?.json?.fulfillment, 'Pickup');
} };

S.threeCauses = { causes: true, order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.locator('input[name=causes]').nth(1).uncheck();
  await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.eq('done causes', (await x.doneInfo()).causes, `It’s divided evenly across ${causeName(ALL[0])}, ${causeName(ALL[2])}, and ${causeName(ALL[3])}.`);
} };

S.oneCause = { causes: true, order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  // Uncheck by tapping the label text, the way a phone user would.
  for (const i of [0, 1, 3]) await page.locator('fieldset label', { has: page.locator('input[name=causes]') }).nth(i).locator('b').click();
  await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.eq('causes sent', x.orders()[0]?.json?.causes, [ALL[2]]);
  x.eq('done causes', (await x.doneInfo()).causes, `It all goes to ${causeName(ALL[2])}.`);
} };

S.noCause = { causes: true, order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  for (let i = 0; i < 4; i++) await page.locator('input[name=causes]').nth(i).uncheck();
  await page.click('#order-submit');
  x.eq('error', await x.waitError(3000), 'Leave at least one cause checked.');
  x.eq('nothing sent', x.orders().length, 0);
  await page.locator('input[name=causes]').nth(2).check();
  await page.click('#order-submit');
  x.expect('done after re-checking one', await x.waitDone(), await x.errorText());
} };

S.validation = { order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready();
  await page.focus('input[name=name]'); await page.keyboard.type('A'); await page.keyboard.press('Enter');
  await sleep(300);
  x.eq('enter with an empty cart sends nothing', x.orders().length, 0);
  await page.fill('input[name=name]', '');
  await x.more(ID.apple);
  await page.click('#order-submit');
  x.eq('no name', await x.waitError(3000), 'We need your name.');
  await page.fill('input[name=name]', 'Testy');
  await page.fill('input[name=email]', 'testy.example.com');
  await page.click('#order-submit');
  x.eq('bad email', await x.waitError(3000), 'We need your email.');
  await page.fill('input[name=email]', 'testy@example.com');
  await page.fill('input[name=mobile]', '555-12');
  await page.click('#order-submit');
  x.eq('short mobile', await x.waitError(3000), 'We need your mobile number, so we can follow up.');
  x.eq('nothing sent', x.orders().length, 0);
  // Pressing Go/Enter in the last field submits, as a phone keyboard does.
  await page.fill('input[name=mobile]', '+1 612 555 0100');
  await page.focus('input[name=mobile]'); await page.keyboard.press('Enter');
  x.expect('enter in mobile submits', await x.waitDone(), await x.errorText());
  x.eq('mobile kept as typed', x.orders()[0]?.json?.mobile, '+1 612 555 0100');
} };

S.limits = { stock: stockOf((s) => { const xl = s.products.find((p) => p.id === ID.tnXL); xl.left = 0; xl.limit = 0; }), order: [ok({ ok: true })], async run(x, page) {
  await x.ready();
  x.eq('sold-out XL says All gone', (await x.note(ID.tnXL)).trim(), '· All gone');
  x.expect('sold-out XL greyed', await page.$eval(`[data-product="${ID.tnXL}"]`, (r) => r.classList.contains('is-out')), 'no is-out');
  x.expect('sold-out XL + disabled', await x.moreDisabled(ID.tnXL), 'enabled');
  x.eq('golden ticket note', (await x.note(ID.golden)).trim(), '· 4 available · 2 per order');
  x.eq('9 XL note', (await x.note(ID.wwXL)).trim(), '· 9 available');
  x.eq('lid 68 left, no note', (await x.note(ID.lid)).trim(), '');
  x.eq('preorder candle, no note', (await x.note(ID.trueNorth)).trim(), '');
  await x.more(ID.golden, 2);
  x.expect('golden ticket stops at 2', await x.moreDisabled(ID.golden), 'still enabled at 2');
  await x.more(ID.trueNorth, 24);
  x.eq('line stops at 24', await x.qty(ID.trueNorth), '24');
  x.expect('+ disabled at 24', await x.moreDisabled(ID.trueNorth), 'enabled');
  await x.more(ID.apple, 4);
  x.eq('30 in the order', await x.qty(ID.apple), '4');
  x.eq('top-out message', await x.errorText(), `Online orders top out at 30. For a bigger one, email ${EMAIL}.`);
  x.expect('every + disabled at 30', await page.$$eval('[data-more]', (b) => b.every((e) => e.disabled)), 'some + enabled');
  x.eq('total at 30', await x.total(), '$1,200');
  await x.less(ID.apple);
  x.eq('message clears below 30', await x.errorText(), '');
  x.expect('- disabled at 0', await page.isDisabled(`[data-product="${ID.lid}"] [data-less]`), 'enabled');
} };

S.retry429 = { order: [{ status: 429, body: {} }, { status: 429, body: {} }, ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('button says placing', await page.textContent('#order-submit'), 'Placing your order…');
  x.expect('steppers locked while sending', await page.isDisabled(`[data-product="${ID.apple}"] [data-more]`), 'enabled');
  x.expect('done after two 429s', await x.waitDone(), await x.errorText());
  const o = x.orders();
  x.eq('three tries', o.length, 3);
  x.expect('same request id each try', new Set(o.map((r) => r.json?.requestId)).size === 1, o.map((r) => r.json?.requestId));
  x.expect('every hash right', o.every((r) => r.hashOk), 'a hash mismatch');
  x.expect('backoff about 2 s then 4 s', o.length === 3 && o[1].at - o[0].at > 1700 && o[2].at - o[1].at > 3700, o.map((r) => r.at - o[0].at));
} };

S.retry503 = { order: [{ status: 503, body: { error: 'unavailable' } }, ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.expect('done after a 503', await x.waitDone(), await x.errorText());
  x.eq('two tries, one id', [x.orders().length, new Set(x.orders().map((r) => r.json?.requestId)).size], [2, 1]);
} };

// Dropped requests are aborted in the browser (see runOne): a reset socket makes Chromium resend a POST.
S.offline = { order: [{ abort: true }, { abort: true }, { abort: true }, { abort: true }, ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('message after 4 dropped tries', await x.waitError(30000), MSG.wrong);
  x.eq('four tries', x.orders().length, 4);
  x.expect('button back to Place order', (await page.textContent('#order-submit')) === 'Place order' && !(await page.isDisabled('#order-submit')), await page.textContent('#order-submit'));
  await page.click('#order-submit');
  x.expect('done on the retry', await x.waitDone(), await x.errorText());
  const o = x.orders();
  x.expect('retry keeps the request id', new Set(o.map((r) => r.json?.requestId)).size === 1, o.map((r) => r.json?.requestId));
  x.expect('retry carries a fresh token', !!o[4]?.json?.turnstile, 'no token on retry');
} };

S.short409 = { order: [{ status: 409, body: { error: 'short', short: [{ id: ID.wwXL, name: 'Winter Wonderland XL', left: 0 }] } }, ok({ ok: true, total: 50 })], async run(x, page) {
  await x.ready(); await x.more(ID.wwXL); await x.more(ID.trueNorth, 2); await x.fill();
  await page.click('#order-submit');
  x.eq('short message', await x.waitError(), 'We have no Winter Wonderland XL left, so we changed your order. Check it and press Place order again.');
  x.eq('XL dropped from cart', await x.qty(ID.wwXL), '0');
  x.eq('total updated', await x.total(), '$50');
  x.expect('XL now greyed', await page.$eval(`[data-product="${ID.wwXL}"]`, (r) => r.classList.contains('is-out')), 'not is-out');
  await page.click('#order-submit');
  x.expect('done on resend', await x.waitDone(), await x.errorText());
  const o = x.orders();
  x.expect('changed order gets a new id', o.length === 2 && o[0].json.requestId !== o[1].json.requestId, o.map((r) => r.json?.requestId));
  x.eq('resent items', o[1]?.json?.items, [{ product: ID.trueNorth, quantity: 2 }]);
} };

S.turnstile422 = { order: [{ status: 422, body: { error: 'turnstile' } }, ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('message', await x.waitError(), 'Our spam check didn’t go through. Wait a moment, then press Place order again.');
  await page.click('#order-submit');
  x.expect('done on second press', await x.waitDone(), await x.errorText());
  x.expect('second try has a token', !!x.orders()[1]?.json?.turnstile, 'no token');
} };

S.invalid422 = { order: [{ status: 422, body: { error: 'invalid', fields: ['email', 'mobile'] } }], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('message names the fields', await x.waitError(), 'Please check your email and your mobile number.');
} };

S.unknown422 = { order: [{ status: 422, body: { error: 'unknown-product' } }], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('message', await x.waitError(), `One of those isn’t available online. Reload the page, or email ${EMAIL}.`);
} };

S.slowDown = { order: [{ status: 429, body: { error: 'slow-down' } }], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('message', await x.waitError(), `That’s a lot of orders in a short time. Try again in a while, or email ${EMAIL}.`);
  x.eq('no retry on slow-down', x.orders().length, 1);
} };

S.closedOnOrder = { order: [{ status: 503, body: { open: false, window: 'paused' } }], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  await page.waitForSelector('#order-shut:not([hidden])', { timeout: 15000 }).catch(() => {});
  const shown = await page.$$eval('[data-window]', (h) => h.filter((e) => !e.hidden).map((e) => e.dataset.window));
  // Which paused words show depends on the date: "come see us" until the sale ends, "counting" after.
  x.expect('paused heading', shown.length === 1 && /^paused-(sale|count)$/.test(shown[0]), shown);
  x.expect('form hidden', await page.$eval('#order-form', (f) => f.hidden), 'form showing');
  x.eq('no retry when shut', x.orders().length, 1);
} };

S.stockClosed = { stock: [{ status: 503, body: { open: false, window: 'closed' } }], async run(x, page) {
  await page.waitForSelector('#order-shut:not([hidden])', { timeout: 15000 }).catch(() => {});
  const shown = await page.$$eval('[data-window]', (h) => h.filter((e) => !e.hidden).map((e) => e.dataset.window));
  x.eq('closed heading', shown, ['closed']);
  x.eq('status cleared', await page.$eval('#order-status', (s) => s.hidden), true);
  x.eq('no turnstile loaded', await page.$$eval('script[src*="turnstile"]', (s) => s.length), 0);
} };

S.stockError = { stock: [{ status: 500, body: { error: 'server' } }], async run(x, page) {
  await page.waitForFunction(() => /couldn’t load/.test(document.getElementById('order-status').textContent), null, { timeout: 15000 }).catch(() => {});
  x.eq('status', await page.textContent('#order-status'), `We couldn’t load the candles. Try again in a minute, or email ${EMAIL}.`);
} };

S.stock429 = { stock: [{ status: 429, body: {} }, ...stockOf()], async run(x, page) {
  await x.ready().catch(() => {});
  x.expect('form after a stock 429', await page.$eval('#order-form', (f) => !f.hidden), 'form hidden');
} };

S.soldOut = { stock: stockOf((s) => { s.products = []; }), async run(x, page) {
  await page.waitForFunction(() => /sold out/.test(document.getElementById('order-status').textContent), null, { timeout: 15000 }).catch(() => {});
  x.eq('status', await page.textContent('#order-status'), 'We’re all sold out. Thank you, everyone!');
} };

S.afterWindow = { stock: stockOf((s) => { s.window = 'after'; }), order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready();
  const shown = await page.$$eval('[data-window]', (h) => h.filter((e) => !e.hidden).map((e) => e.dataset.window));
  x.eq('service window wins', shown, ['after']);
  await x.more(ID.apple); await x.fill(); await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.eq('after-window pickup words', (await x.doneInfo()).next, MSG.nextAfter);
} };

S.turnstileBlocked = { block: /challenges\.cloudflare\.com/, order: [ok({ ok: true })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('message', await x.waitError(5000), `Our spam check didn’t load. Reload the page, or email ${EMAIL}.`);
  x.eq('nothing sent', x.orders().length, 0);
  x.eq('button back', await page.textContent('#order-submit'), 'Place order');
} };

S.turnstileFails = { key: 'fail', order: [ok({ ok: true })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.click('#order-submit');
  x.eq('message after 15 s', await x.waitError(25000), MSG.notYet);
  x.eq('nothing sent', x.orders().length, 0);
} };

S.doubleClick = { order: [{ status: 200, body: { ok: true, total: 25 }, delay: 1500 }], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.dblclick('#order-submit');
  await page.click('#order-submit', { force: true }).catch(() => {});
  await page.focus('input[name=mobile]'); await page.keyboard.press('Enter');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.eq('only one request', x.orders().length, 1);
} };

S.keyboard = { causes: true, desktop: true, order: [ok({ ok: true, total: 50 })], async run(x, page, t) {
  await x.ready();
  const TAB = t.engineType === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.focus(`[data-product="${ID.apple}"] [data-more]`);
  await page.keyboard.press('Enter'); await page.keyboard.press(' ');
  x.eq('enter and space add', await x.qty(ID.apple), '2');
  await page.focus('input[name=name]');
  await page.keyboard.type('Keyboard Kim'); await page.keyboard.press(TAB);
  await page.keyboard.type('kim@example.com'); await page.keyboard.press(TAB);
  await page.keyboard.type('6125550100'); await page.keyboard.press(TAB);
  x.eq('tab reaches the first radio', await page.evaluate(() => document.activeElement.value), 'Pickup');
  await page.keyboard.press('ArrowDown');
  x.eq('arrow picks SPS', await page.evaluate(() => document.querySelector('input[name=fulfillment]:checked').value), 'SPS delivery');
  await page.keyboard.press(TAB);
  x.eq('tab reaches the first cause', await page.evaluate(() => document.activeElement.name), 'causes');
  await page.keyboard.press(' ');
  x.eq('space unchecks it', await page.evaluate(() => document.querySelector('input[name=causes]').checked), false);
  await page.focus('#order-submit'); await page.keyboard.press('Enter');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.eq('sent', [x.orders()[0]?.json?.fulfillment, x.orders()[0]?.json?.causes?.length], ['SPS delivery', 3]);
} };

S.backForward = { order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill(); await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  await page.click('#order-done a[href="/pay/"]');
  await page.waitForURL(/\/pay\/$/);
  await page.goBack();
  await sleep(1500);
  x.eq('no second order on back', x.orders().length, 1);
  const state = await page.evaluate(() => ({ done: !document.getElementById('order-done').hidden, form: !document.getElementById('order-form').hidden }));
  x.expect('back shows the done screen or a fresh form', state.done || state.form, JSON.stringify(state));
  x.remark(`back: ${JSON.stringify(state)}`);
} };

S.reload = { causes: true, order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready();
  await page.locator('input[name=causes]').nth(0).uncheck();
  await page.fill('input[name=name]', 'Reload Ray');
  await page.reload();
  await x.ready();
  const vis = await page.$$eval('input[name=causes]', (b) => b.map((e) => e.checked));
  x.remark(`causes after reload ${JSON.stringify(vis)}, name "${await page.inputValue('input[name=name]')}"`);
  await x.more(ID.apple); await x.fill(); await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.eq('sent causes match the boxes shown', x.orders()[0]?.json?.causes, ALL.filter((_, i) => vis[i]));
  x.eq('done text matches', (await x.doneInfo()).causes !== null, true);
} };

// What a buyer on a browser from before Safari 15.4 or Chrome 92 gets: the fallbacks at the top of the
// page's script stand in for these.
S.olderBrowser = { causes: true, init: 'delete Crypto.prototype.randomUUID; delete Intl.ListFormat; delete Element.prototype.replaceChildren; delete DocumentFragment.prototype.replaceChildren;', order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  await page.locator('input[name=causes]').nth(1).uncheck();
  await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  x.expect('request id is still a uuid', UUID.test(x.orders()[0]?.json?.requestId || ''), x.orders()[0]?.json?.requestId);
  x.eq('causes listed without Intl.ListFormat', (await x.doneInfo()).causes, `It’s divided evenly across ${causeName(ALL[0])}, ${causeName(ALL[2])}, and ${causeName(ALL[3])}.`);
} };

S.layout = { layout: true, order: [ok({ ok: true, total: 110 })], async run(x, page, t) {
  await x.ready();
  await x.more(ID.trueNorth, 2); await x.more(ID.golden);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await x.tokenReady();
  const m = await page.evaluate(() => {
    const de = document.documentElement, W = de.clientWidth;
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.width), Math.round(b.height)]; };
    const sticking = [...document.querySelectorAll('#order-form *')].filter((e) => !e.closest('.order-trap')).filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > W + 1 || b.left < -1); }).slice(0, 6).map((e) => `${e.tagName.toLowerCase()}.${e.className} [${Math.round(e.getBoundingClientRect().left)},${Math.round(e.getBoundingClientRect().right)}]`);
    const fonts = [...document.querySelectorAll('#order-form .order-field input[type=text],#order-form input[type=email],#order-form input[type=tel],#order-form textarea')].map((i) => parseFloat(getComputedStyle(i).fontSize));
    const tap = [...document.querySelectorAll('[data-more],[data-less]')].map((b) => b.getBoundingClientRect()).map((b) => Math.min(b.width, b.height));
    const height = (id) => Math.round(document.getElementById(id).getBoundingClientRect().height);
    return { W, scrollW: de.scrollWidth, sticking, minInputFont: Math.min(...fonts), minTap: Math.round(Math.min(...tap)), panel: r('.order-panel'), products: r('#order-products'), checkH: height('order-check'), hintH: height('order-check-hint') };
  });
  x.expect('no sideways scroll', m.scrollW <= m.W, `scrollWidth ${m.scrollW} > ${m.W}; ${m.sticking.join('; ')}`);
  x.expect('nothing in the form past the edge', m.sticking.length === 0, m.sticking.join('; '));
  x.expect('inputs at 16px or more (no iOS zoom)', m.minInputFont >= 16, m.minInputFont);
  x.expect('+/− at least 32 px', m.minTap >= 32, m.minTap);
  x.expect('pass key keeps the widget and its hint hidden', m.checkH < 5 && m.hintH === 0, [m.checkH, m.hintH]);
  x.remark(`width ${m.W}, panel ${m.panel}, products ${m.products}, smallest button ${m.minTap}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${t.label}-form.png`), fullPage: true });
  await x.fill(); await page.click('#order-submit');
  x.expect('done', await x.waitDone(), await x.errorText());
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${t.label}-done.png`) });
} };

// The 3x test key always asks for a click, as real Turnstile does for a buyer it isn't sure of.
S.interactiveWidget = { key: 'interactive', layout: true, order: [ok({ ok: true })], async run(x, page, t) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  x.expect('a forced challenge shows the widget', await x.boxShows(), 'no visible widget');
  x.eq('the hint shows with it', await x.waitHint(), HINT);
  await sleep(1500);
  const box = await page.evaluate(() => {
    const b = document.getElementById('order-check').getBoundingClientRect(), h = document.getElementById('order-check-hint').getBoundingClientRect();
    return { box: [Math.round(b.width), Math.round(b.height)], hintBelowBox: h.top >= b.bottom - 1, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  x.expect('widget fits without sideways scroll', box.fits, box);
  x.expect('hint sits under the box', box.hintBelowBox, box);
  x.remark(`widget ${box.box}`);
  if (SHOTS) await page.locator('.order-panel').screenshot({ path: path.join(SHOTS, `${t.label}-widget.png`) }).catch(() => {});
} };

S.humanClick = { key: 'interactive', order: [ok({ ok: true, total: 25 })], async run(x, page) {
  await x.ready(); await x.more(ID.apple); await x.fill();
  x.expect('box shows', await x.boxShows(), 'no widget');
  x.eq('hint shows before Place order is pressed', await x.waitHint(), HINT);
  await page.click('#order-submit');
  x.eq('message while the box waits', await x.waitError(25000), MSG.notYet);
  const b = await page.$eval('#order-check', (e) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, h: r.height }; });
  await page.mouse.click(b.x + 30, b.y + b.h / 2);
  x.expect('token after the click', await x.tokenReady(), 'no token after clicking the box');
  x.eq('hint clears once the box is checked', await x.hint(), '');
  await page.click('#order-submit');
  x.expect('done after checking the box', await x.waitDone(), await x.errorText());
  x.eq('sent with the token', x.orders()[0]?.json?.turnstile, 'XXXX.DUMMY.TOKEN.XXXX');
} };

S.clickWhileWaiting = { key: 'interactive', order: [ok({ ok: true, total: 25 })], async run(x, page) {
  // A buyer who presses Place order first and then checks the box within 15 s: the order goes on its own.
  await x.ready(); await x.more(ID.apple); await x.fill();
  await x.boxShows();
  await page.click('#order-submit');
  await sleep(2000);
  const b = await page.$eval('#order-check', (e) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, h: r.height }; });
  await page.mouse.click(b.x + 30, b.y + b.h / 2);
  x.expect('order goes through without a second press', await x.waitDone(20000), await x.errorText());
} };

// ---- engines ------------------------------------------------------------------------------------
// The first five run every scenario; the extra sizes run `layout` ones and the happy path.
const D = pw.devices;
const ENGINES = {
  chromium: { type: 'chromium', ctx: { viewport: { width: 1280, height: 900 } } },
  firefox: { type: 'firefox', ctx: { viewport: { width: 1280, height: 900 } } },
  webkit: { type: 'webkit', ctx: { viewport: { width: 1280, height: 900 } } },
  iphone15: { type: 'webkit', ctx: D['iPhone 15'] },
  pixel7: { type: 'chromium', ctx: D['Pixel 7'] },
  iphoneSE: { type: 'webkit', ctx: D['iPhone SE'], sizes: true },
  iphoneMax: { type: 'webkit', ctx: D['iPhone 15 Pro Max'], sizes: true },
  ipad: { type: 'webkit', ctx: D['iPad Mini'], sizes: true },
  galaxyS8: { type: 'chromium', ctx: D['Galaxy S8'], sizes: true },
  firefoxNarrow: { type: 'firefox', ctx: { viewport: { width: 390, height: 844 } }, sizes: true },
  webkitTablet: { type: 'webkit', ctx: { viewport: { width: 1024, height: 768 } }, sizes: true },
  chromiumDark: { type: 'chromium', ctx: { viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true }, sizes: true },
  chrome: { type: 'chromium', launch: { channel: 'chrome' }, ctx: { viewport: { width: 1440, height: 900 } }, named: true },
};

// Console noise from Turnstile, Tinylytics (blocked here) and the browsers themselves.
const NOISE = /challenges\.cloudflare|turnstile|Failed to load resource|tinylytics|net::ERR_FAILED|403|Private Access Token|xr-spatial|preload/i;

let BASE;
async function runOne(browser, eng, name, label) {
  const sc = S[name];
  const id = crypto.randomUUID();
  const scn = { key: sc.key, stock: structuredClone(sc.stock || stockOf()), order: structuredClone(sc.order || [ok({ ok: true })]), log: { stock: [], order: [] } };
  scenarios.set(id, scn);
  const context = await browser.newContext({ ...eng.ctx, baseURL: BASE });
  await context.addCookies([{ name: 'scn', value: id, url: BASE }]);
  if (sc.init) await context.addInitScript(sc.init);
  const t = { label: `${label}-${name}`, checks: [], errors: [], notes: [], external: new Set(), engineType: eng.type };
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE + '/api/order') && scn.order[0] && scn.order[0].abort) {
      scn.order.shift();
      const raw = route.request().postData() || '';
      let json = null; try { json = JSON.parse(raw); } catch {}
      scn.log.order.push({ at: Date.now(), dropped: true, type: route.request().headers()['content-type'], hashOk: crypto.createHash('sha256').update(raw).digest('hex') === route.request().headers()['x-amz-content-sha256'], json });
      return route.abort('internetdisconnected');
    }
    // WebKit routes data: and blob: URLs too; they reach no host.
    if (u.startsWith(BASE) || !/^https?:/.test(u)) return route.continue();
    const host = new URL(u).host;
    if (sc.block && sc.block.test(u)) return route.abort();
    if (/(^|\.)cloudflare\.com$|fonts\.(googleapis|gstatic)\.com$/.test(host)) return route.continue();
    if (host !== 'tinylytics.app') t.external.add(host);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => t.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) t.errors.push(`console: ${m.text().slice(0, 200)}`); });
  const x = tools(page, scn, t);
  try {
    await page.goto('/order/');
    await sc.run(x, page, t);
  } catch (e) {
    t.checks.push({ name: 'scenario threw', ok: false, detail: e.message.split('\n')[0] });
  }
  if (scn.log.stock.length === 0) t.checks.push({ name: 'the stub saw the page', ok: false, detail: 'no stock request reached the stub' });
  if (t.external.size) t.checks.push({ name: 'no requests to other hosts', ok: false, detail: [...t.external] });
  await context.close();
  scenarios.delete(id);
  return t;
}

const wanted = process.env.BROWSERS ? process.env.BROWSERS.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(ENGINES).filter((k) => !ENGINES[k].named);
const only = process.env.SCENARIOS ? new RegExp(process.env.SCENARIOS) : null;

test('order form in real browsers', { concurrency: true }, async (top) => {
  assert.ok(fs.existsSync(path.join(SITE, 'order', 'index.html')), 'no _site/order/index.html: run npm run build first (npm run test:browsers does)');
  for (const label of wanted) assert.ok(ENGINES[label], `unknown browser ${label}; known: ${Object.keys(ENGINES).join(', ')}`);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  top.after(() => server.close());
  await Promise.all(wanted.map((label) => top.test(label, { concurrency: 4 }, async (et) => {
    const eng = ENGINES[label];
    const browser = await pw[eng.type].launch(eng.launch || {});
    et.diagnostic(`${eng.type} ${browser.version()}`);
    const names = Object.keys(S).filter((n) => (eng.sizes ? S[n].layout || n === 'happy' : true)).filter((n) => !only || only.test(n));
    try {
      await Promise.all(names.map((name) => et.test(name, async (st) => {
        if (S[name].causes && CAUSES.length < 4) return st.skip('needs four causes in causes.json');
        if (S[name].desktop && eng.ctx.isMobile) return st.skip('desktop only: emulated phones type differently');
        const r = await runOne(browser, eng, name, label);
        for (const note of r.notes) st.diagnostic(note);
        const bad = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)}`);
        assert.deepEqual([...bad, ...r.errors], [], `${label} ${name}`);
      })));
    } finally {
      await browser.close();
    }
  })));
});
