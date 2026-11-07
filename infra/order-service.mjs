// The candle order service behind things4good.xyz/api/: one Lambda function, reserved concurrency 1, so
// a stock check and the write that follows never overlap and two buyers can't get the last candle.
//
//   GET  /api/stock   the order window, and what can be ordered at the current event: products, prices,
//                     quantities. No buyer data.
//   POST /api/order   validate, re-read stock from Grist, write the order, return the total.
//
// The order windows (Jamie, 2026-11-07) make the sale two weeks long. Orders open about a week before
// the sale and take candles ahead of what is poured; they pause while the sale runs, because counts
// can't stay right with candles going out the door, and until the paper sheets are in and recounted;
// then they open for a week with whatever is left. See currentWindow.
//
// Prices and availability come only from Grist, never from the browser. Everything the distribution
// shows as a 403 or 404 becomes the site's HTML 404 page (CustomErrorResponses), so this answers only
// with 200, 400, 405, 409, 413, 422, 429, 500 and 503.
//
// Every order carries a Cloudflare Turnstile token, checked before any call to Grist; a refused token
// is a 422, never a 403. Each new order then adds the buyer to the family's Buttondown list, without a
// confirmation email and never over an unsubscribe. A list failure is logged and never fails the order.
//
// The Grist key, the document id, the Turnstile secret and the Buttondown key live in one secret, so none
// is in this public repo. Logs carry outcomes only: no name, email, phone, note or IP, and never the text
// of a Grist error.

const CANDLE = 'Candle';
const MAKER_NIGHT = 'Maker Night candle'; // The Golden Ticket: a seat at Maker Night, two to an order.
const MAKER_NIGHT_PER_ORDER = 2;

export const LIMITS = Object.freeze({
  bodyBytes: 8 * 1024,
  name: 100,
  email: 254,
  mobile: 30,
  note: 500,
  lineQuantity: 24, // The largest line in six years of orders.
  orderQuantity: 30, // The largest order in six years is 20 candles.
  ordersPerIpPerHour: 5,
  attemptsPerIpPerHour: 20,
  ordersPerHour: 30
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUR = 3_600_000;
const FULFILLMENT = new Set(['Pickup', 'SPS delivery']);
const ORDER_TYPE = { preorder: 'Preorder', after: 'After the sale' };
const STOCK_CACHE = 'public, max-age=60, s-maxage=300';

// The widget is set to these hosts in Cloudflare; a token solved anywhere else is refused here too.
const TURNSTILE_HOSTS = new Set(['things4good.xyz', 'www.things4good.xyz']);
const TURNSTILE_ACTION = 'order';
// Codes that mean our secret or our request is wrong, or Cloudflare is, rather than the buyer's token.
const TURNSTILE_OURS = new Set(['missing-input-secret', 'invalid-input-secret', 'bad-request', 'internal-error']);
// A token is good once. A retry of the same order (the page resends after a 503) passes on the request
// id it already proved, for this long.
const VERIFIED_FOR = 15 * 60_000;
// Buttondown's answers for an address it already has, subscribed or not. Never resubscribed.
const LIST_ALREADY = new Set(['email_already_exists', 'subscriber_already_exists', 'subscriber_suppressed', 'subscriber_blocked']);

const clean = (value) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '');

// The same format scripts/import_preorders.py gives a phone in t4g-candles.
export function formatMobile(value) {
  const typed = clean(value);
  let digits = typed.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : typed;
}

//   preorder  open until `closes`, then paused. Regular candles have no cap: the family pours to fill
//             them, and Left going below zero in Grist is the list to pour. Everything else is capped.
//   paused    the sale is on, or its paper sheets and recount are not in yet. Opened again by hand.
//   after     the leftovers week: open until `closes`, then closed. Everything is capped at what is left.
//   closed    the rest of the year.
// An open window whose closing time is missing or unreadable is not open.
export const WINDOWS = Object.freeze(['preorder', 'paused', 'after', 'closed']);
const AFTERWARDS = { preorder: 'paused', after: 'closed' };
export const isOpen = (window) => Object.hasOwn(ORDER_TYPE, window);

export function currentWindow({ window, closes } = {}, at = Date.now()) {
  if (!WINDOWS.includes(window)) return 'closed';
  if (!isOpen(window)) return window;
  return at < Date.parse(closes) ? window : AFTERWARDS[window];
}

// The form sells everything the current event offers (Jamie, 2026-11-07: "a full sales order method"),
// except the Golden Ticket until goldenTicket is on, because the Maker Night page's seat count doesn't
// follow Grist yet. Left is Made + Adjustment - Sold, never below zero. `limit` is the most one order can
// take: what is left, at most 24, and at most two Golden Tickets. A preorder candle has no count (left is
// null), since it is poured to order. Nothing about any buyer is in here: Sold is one number per product.
export function toStock(rows, { window = 'after', goldenTicket = false } = {}) {
  const events = new Set(rows.map((row) => row.event));
  if (events.size > 1) throw new StepError('stock', 'more than one current event');
  const products = rows
    .filter((row) => goldenTicket || row.type !== MAKER_NIGHT)
    .map((row) => {
      const poured = window === 'preorder' && row.type === CANDLE;
      const left = Math.max(0, (Number(row.made) || 0) + (Number(row.adjustment) || 0) - (Number(row.sold) || 0));
      const most = row.type === MAKER_NIGHT ? MAKER_NIGHT_PER_ORDER : LIMITS.lineQuantity;
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        price: Number(row.price) || 0,
        left: poured ? null : left,
        limit: poured ? most : Math.min(left, most)
      };
    });
  return { eventId: rows[0]?.eventId ?? null, event: rows[0]?.event ?? null, products };
}

export function validate(body) {
  const errors = [];
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  if (!UUID.test(requestId)) errors.push('requestId');
  const name = clean(body.name);
  if (!name || name.length > LIMITS.name) errors.push('name');
  const email = clean(body.email).toLowerCase();
  if (email.length > LIMITS.email || !EMAIL.test(email)) errors.push('email');
  const mobile = formatMobile(body.mobile);
  if (mobile.length > LIMITS.mobile || (mobile && !/^[\d\s()+.-]+$/.test(mobile))) errors.push('mobile');
  if (!FULFILLMENT.has(body.fulfillment)) errors.push('fulfillment');
  const note = clean(body.note);
  if (note.length > LIMITS.note) errors.push('note');

  const items = Array.isArray(body.items) ? body.items : [];
  const seen = new Set();
  let quantity = 0;
  let itemsValid = items.length > 0;
  for (const item of items) {
    const ok =
      item &&
      Number.isInteger(item.product) &&
      item.product > 0 &&
      !seen.has(item.product) &&
      Number.isInteger(item.quantity) &&
      item.quantity > 0 &&
      item.quantity <= LIMITS.lineQuantity;
    if (!ok) {
      itemsValid = false;
      break;
    }
    seen.add(item.product);
    quantity += item.quantity;
  }
  if (!itemsValid || quantity > LIMITS.orderQuantity) errors.push('items');

  return errors.length
    ? { errors }
    : {
        order: {
          requestId: requestId.toLowerCase(),
          name,
          email,
          mobile,
          fulfillment: body.fulfillment,
          note,
          items: items.map(({ product, quantity: q }) => ({ product, quantity: q }))
        }
      };
}

class StepError extends Error {
  constructor(step, reason) {
    super(reason);
    this.step = step;
  }
}

// A sliding hour of timestamps per key. Reserved concurrency 1 means one environment holds the counts;
// they reset when Lambda replaces it, which is good enough to slow a script down on a family site.
function rateLimiter(now) {
  const hits = new Map();
  const recent = (key) => {
    const kept = (hits.get(key) ?? []).filter((time) => now() - time < HOUR);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
    return kept;
  };
  return {
    count: (key) => recent(key).length,
    add: (key) => hits.set(key, [...recent(key), now()])
  };
}

const viewerIp = (headers = {}) => {
  const address = headers['cloudfront-viewer-address'] ?? '';
  // "1.2.3.4:5678" or "2001:db8::1:5678": the port is what follows the last colon.
  const index = address.lastIndexOf(':');
  return index > 0 ? address.slice(0, index) : 'unknown';
};

const json = (statusCode, body, cache = 'no-store') => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  body: JSON.stringify(body)
});

const LOGGERS = { error: console.error, warn: console.warn };

export function createService({
  store,
  // ({ token }) => { ok, codes }, or throws when Turnstile can't answer. Without one, no order gets in.
  verify = async () => {
    throw new StepError('turnstile', 'no verifier');
  },
  // ({ email, ip }) => { outcome: 'added' | 'already' | 'refused' | 'skipped', code }, or throws.
  subscribe = async () => ({ outcome: 'skipped' }),
  // { window, closes, goldenTicket }: see currentWindow and toStock. Without one, nothing is open.
  orders = { window: 'closed' },
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (entry) => (LOGGERS[entry.level] ?? console.log)(entry),
  // A known email and a new one take different numbers of Grist calls, so an order never answers
  // sooner than this, which covers both. It holds the one slot, and the page retries a 429.
  floorMs = 3000
} = {}) {
  const limiter = rateLimiter(now);
  const verified = new Map(); // requestId -> when its token passed.

  const rules = (window) => ({ window, goldenTicket: orders.goldenTicket === true });

  const stockResponse = async (window) => {
    const { event, products } = toStock(await store.readStock(), rules(window));
    return json(
      200,
      { open: true, window, closes: orders.closes, event, products: products.filter((product) => product.limit > 0) },
      STOCK_CACHE
    );
  };

  const placeOrder = async (event, window) => {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
    if (Buffer.byteLength(raw) > LIMITS.bodyBytes) return { response: json(413, { error: 'too-large' }), outcome: 'too-large' };
    if (!/^application\/json\b/i.test(event.headers?.['content-type'] ?? ''))
      return { response: json(400, { error: 'bad-request' }), outcome: 'bad-request' };

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { response: json(400, { error: 'bad-request' }), outcome: 'bad-request' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return { response: json(400, { error: 'bad-request' }), outcome: 'bad-request' };

    const ip = viewerIp(event.headers);
    if (limiter.count(`attempt:${ip}`) >= LIMITS.attemptsPerIpPerHour)
      return { response: json(429, { error: 'slow-down' }), outcome: 'rate-limited' };
    limiter.add(`attempt:${ip}`);

    // The trap: a generic refusal, not a fake success, so a real buyer whose browser filled the hidden
    // field is told it didn't work rather than left thinking it did.
    if (body.website) return { response: json(422, { error: 'invalid', fields: [] }), outcome: 'trap' };

    const { errors, order } = validate(body);
    if (errors) return { response: json(422, { error: 'invalid', fields: errors }), outcome: 'invalid' };

    for (const [id, at] of verified) if (now() - at >= VERIFIED_FOR) verified.delete(id);
    if (!verified.has(order.requestId)) {
      const check = await verify({ token: body.turnstile });
      if (!check.ok) return { response: json(422, { error: 'turnstile' }), outcome: 'turnstile', codes: check.codes };
      verified.set(order.requestId, now());
    }

    const sourceRow = `web ${order.requestId}`;
    const previous = await store.findOrder(sourceRow);
    if (previous && previous.lines > 0) return { response: json(200, { ok: true, total: previous.total }), outcome: 'duplicate', floor: true };

    if (limiter.count(`order:${ip}`) >= LIMITS.ordersPerIpPerHour || limiter.count('orders') >= LIMITS.ordersPerHour)
      return { response: json(429, { error: 'slow-down' }), outcome: 'rate-limited' };

    // An attempt that died between the order and its lines left an empty order behind.
    if (previous) await store.removeOrder(previous.id);

    const stock = toStock(await store.readStock(), rules(window));
    if (!stock.eventId) throw new StepError('stock', 'no current event');
    const known = new Map(stock.products.map((product) => [product.id, product]));
    if (order.items.some((item) => !known.has(item.product)))
      return { response: json(422, { error: 'unknown-product' }), outcome: 'unknown-product' };

    const short = order.items
      .map((item) => ({ item, product: known.get(item.product) }))
      .filter(({ item, product }) => product.left !== null && item.quantity > product.left)
      .map(({ item, product }) => ({ id: product.id, name: product.name, asked: item.quantity, left: product.left }));
    if (short.length) return { response: json(409, { error: 'short', short }), outcome: 'short' };
    // More than one order may take, with enough left: only a third Golden Ticket, which the page never sends.
    if (order.items.some((item) => item.quantity > known.get(item.product).limit))
      return { response: json(422, { error: 'invalid', fields: ['items'] }), outcome: 'invalid' };

    const person = await store.findPerson(order.email);
    let personId = person?.id;
    let createdPerson = false;
    if (person) {
      // Never overwrite an existing person: only fill what is blank.
      const blanks = {};
      if (!person.name) blanks.Name = order.name;
      if (!person.mobile && order.mobile) blanks.Mobile = order.mobile;
      if (Object.keys(blanks).length) await store.fillPerson(person.id, blanks);
    } else {
      personId = await store.addPerson({
        Name: order.name,
        Type: 'Person',
        Email: order.email,
        Mobile: order.mobile,
        Notes: 'Added by the order form'
      });
      createdPerson = true;
    }

    try {
      // One order per call: several in one call break Sale_Order numbering. Sale_Order is left to its
      // trigger, and Causes stays blank, which splits the order evenly across the four.
      const orderId = await store.addOrder({
        Event: stock.eventId,
        Person: personId,
        Name_As_Typed: order.name,
        Order_Type: ORDER_TYPE[window],
        Ordered_At: Math.floor(now() / 1000),
        Fulfillment_Method: order.fulfillment,
        Source_Row: sourceRow,
        Notes: order.note,
        Paid: false
      });
      await store.addLines(order.items.map((item) => ({ Order: orderId, Product: item.product, Quantity: item.quantity })));
    } catch (error) {
      await cleanUp(sourceRow, createdPerson ? personId : null);
      throw error;
    }

    limiter.add(`order:${ip}`);
    limiter.add('orders');
    const total = order.items.reduce((sum, item) => sum + item.quantity * known.get(item.product).price, 0);
    return { response: json(200, { ok: true, total }), outcome: 'created', floor: true, list: await addToList(order.email, ip) };
  };

  // After the order is in, so the list can never cost a buyer their candles.
  const addToList = async (email, ip) => {
    try {
      const { outcome, code } = await subscribe({ email, ip });
      if (outcome === 'refused') log({ level: 'warn', route: 'order', outcome: 'list-refused', code: safeCode(code) });
      return outcome;
    } catch (error) {
      log({ level: 'error', route: 'order', outcome: 'list-failed', step: error.step ?? 'unknown', status: error.status });
      return 'failed';
    }
  };

  // Lines failed, or the answer to a write never came. Remove whatever this attempt left.
  const cleanUp = async (sourceRow, personId) => {
    try {
      const left = await store.findOrder(sourceRow);
      if (left) await store.removeOrder(left.id);
      if (personId) await store.removePerson(personId);
      log({ level: 'error', route: 'order', outcome: 'rolled-back' });
    } catch (error) {
      log({ level: 'error', route: 'order', outcome: 'rollback-failed', step: error.step ?? 'unknown' });
    }
  };

  const route = async (event) => {
    const method = event.requestContext?.http?.method;
    const path = event.rawPath;
    const isStock = path === '/api/stock' && (method === 'GET' || method === 'HEAD');
    const isOrder = path === '/api/order' && method === 'POST';
    if (!isStock && !isOrder) return { response: json(405, { error: 'not-allowed' }), route: 'other', outcome: 'not-allowed' };
    // Read per request, so a window closes on time with no deploy. Closed answers before any call to Grist.
    const window = currentWindow(orders, now());
    if (!isOpen(window)) return { response: json(503, { open: false, window }), route: isStock ? 'stock' : 'order', outcome: 'closed' };
    if (isStock) return { response: await stockResponse(window), route: 'stock', outcome: 'ok' };
    return { ...(await placeOrder(event, window)), route: 'order' };
  };

  return {
    // Reached only by a direct invoke (npm run infra -- orders): a function URL event always carries
    // requestContext. Read only.
    async selfCheck() {
      const window = currentWindow(orders, now());
      // A shut window counts what the leftovers week would offer.
      const { event, products } = toStock(await store.readStock(), rules(isOpen(window) ? window : 'after'));
      return { ok: Boolean(event), event, window, products: products.filter((product) => product.limit > 0).length };
    },

    async handle(event) {
      const started = now();
      let result;
      try {
        result = await route(event);
      } catch (error) {
        const outcome = error.step === 'turnstile' ? 'turnstile-failed' : 'grist-failed';
        log({ level: 'error', outcome, step: error.step ?? 'unknown', status: error.status, codes: error.codes });
        const isOrder = event.requestContext?.http?.method === 'POST';
        result = { response: json(503, { error: 'try-again' }), route: isOrder ? 'order' : 'stock', outcome, floor: isOrder };
      }
      if (result.floor) {
        const wait = floorMs - (now() - started);
        if (wait > 0) await sleep(wait);
      }
      // Whether the viewer's address arrived, so a broken rate limit shows, never the address itself.
      log({
        level: 'info',
        route: result.route,
        outcome: result.outcome,
        status: result.response.statusCode,
        ms: now() - started,
        hasAddress: viewerIp(event.headers) !== 'unknown',
        ...(result.codes ? { codes: result.codes } : {}),
        ...(result.list ? { list: result.list } : {})
      });
      return result.response;
    }
  };
}

// The Grist side. Each named call is one API call, except findOrder and removeOrder, which take two.
export function gristStore({ apiKey, docId, fetch: fetchFn = fetch, base = 'https://docs.getgrist.com/api', onDenied = () => {} }) {
  const call = async (step, path, init = {}) => {
    let response;
    try {
      response = await fetchFn(`${base}/docs/${docId}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(6000)
      });
    } catch (cause) {
      throw new StepError(step, cause.name);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) onDenied();
      const error = new StepError(step, `status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  const post = (step, path, body, method = 'POST') => call(step, path, { method, body: JSON.stringify(body) });
  const sql = async (step, query, args = []) => (await post(step, '/sql', { sql: query, args })).records.map((r) => r.fields);
  const add = async (step, table, records) => (await post(step, `/tables/${table}/records`, { records: records.map((fields) => ({ fields })) })).records;

  return {
    readStock: () =>
      sql(
        'stock',
        `select e.id as eventId, e.Name as event, p.id as id, p.Name as name, p.Type as type,
                o.Price as price, o.Made as made, o.Adjustment as adjustment, o.Sold as sold
           from Offerings o
           join Events e on e.id = o.Event
           join Products p on p.id = o.Product
          where e.Is_Current = 1
          order by p.Type, p.Name`
      ),
    findOrder: async (sourceRow) => {
      const [order] = await sql(
        'find-order',
        `select o.id as id, o.Total as total, (select count(*) from Order_Lines l where l."Order" = o.id) as lines
           from Orders o where o.Source_Row = ? order by o.id limit 1`,
        [sourceRow]
      );
      return order ?? null;
    },
    findPerson: async (email) => {
      const [person] = await sql(
        'find-person',
        'select id, Name as name, Mobile as mobile from People where lower(Email) = ? order by id limit 1',
        [email]
      );
      return person ?? null;
    },
    fillPerson: (id, fields) => post('fill-person', '/tables/People/records', { records: [{ id, fields }] }, 'PATCH'),
    addPerson: async (fields) => (await add('add-person', 'People', [fields]))[0].id,
    addOrder: async (fields) => (await add('add-order', 'Orders', [fields]))[0].id,
    addLines: (lines) => add('add-lines', 'Order_Lines', lines),
    removeOrder: async (id) => {
      const lines = await sql('find-lines', 'select id from Order_Lines where "Order" = ?', [id]);
      const actions = [];
      if (lines.length) actions.push(['BulkRemoveRecord', 'Order_Lines', lines.map((line) => line.id)]);
      actions.push(['BulkRemoveRecord', 'Orders', [id]]);
      await post('remove-order', '/apply', actions);
    },
    removePerson: (id) => post('remove-person', '/apply', [['BulkRemoveRecord', 'People', [id]]])
  };
}

const safeCode = (code) => (typeof code === 'string' && /^[a-z0-9_-]{1,40}$/.test(code) ? code : 'other');

// Cloudflare's siteverify. No remoteip: a browser on two networks can reach Cloudflare over IPv6 and
// CloudFront over IPv4, and the token alone is the check Cloudflare documents.
export function turnstileVerifier({
  secret,
  fetch: fetchFn = fetch,
  url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  onDenied = () => {}
}) {
  return async ({ token }) => {
    if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, codes: ['missing-input-response'] };
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (cause) {
      throw new StepError('turnstile', cause.name);
    }
    if (!response.ok) {
      const error = new StepError('turnstile', `status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const result = await response.json();
    const codes = (Array.isArray(result['error-codes']) ? result['error-codes'] : []).slice(0, 5).map(safeCode);
    if (codes.some((code) => TURNSTILE_OURS.has(code))) {
      if (codes.includes('invalid-input-secret')) onDenied();
      const error = new StepError('turnstile', 'refused our request');
      error.codes = codes;
      throw error;
    }
    if (result.success !== true) return { ok: false, codes };
    if (!TURNSTILE_HOSTS.has(result.hostname)) return { ok: false, codes: ['wrong-hostname'] };
    if (result.action !== TURNSTILE_ACTION) return { ok: false, codes: ['wrong-action'] };
    return { ok: true, codes: [] };
  };
}

// Buttondown. type regular skips the confirmation email: buying candles is the consent the page states.
// No collision header, so an address already there (subscribed or unsubscribed) is left alone. The
// buyer's IP goes along so Buttondown's firewall judges the buyer, not the function's few addresses;
// its bypass header allows only five an hour.
export function buttondownSubscriber({
  apiKey,
  fetch: fetchFn = fetch,
  base = 'https://api.buttondown.com/v1',
  onDenied = () => {}
}) {
  return async ({ email, ip }) => {
    let response;
    try {
      response = await fetchFn(`${base}/subscribers`, {
        method: 'POST',
        headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_address: email,
          type: 'regular',
          notes: 'Added by the order form',
          ...(ip && ip !== 'unknown' ? { ip_address: ip } : {})
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (cause) {
      throw new StepError('buttondown', cause.name);
    }
    if (response.ok) return { outcome: 'added' };
    const body = await response.json().catch(() => ({}));
    const code = typeof body?.code === 'string' ? body.code : undefined;
    if (response.status === 409 || LIST_ALREADY.has(code)) return { outcome: 'already' };
    if ([400, 422, 429].includes(response.status)) return { outcome: 'refused', code: code ?? `status-${response.status}` };
    if (response.status === 401 || response.status === 403) onDenied();
    const error = new StepError('buttondown', `status ${response.status}`);
    error.status = response.status;
    throw error;
  };
}

// The real thing: credentials from Secrets Manager, read once per environment and read again if Grist
// turns the key down, so a rotated key needs no redeploy.
let credentials;
const readCredentials = async () => {
  if (!credentials) {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
    const { apiKey, docId, turnstileSecret, buttondownKey } = JSON.parse(SecretString);
    if (!apiKey || !docId) throw new StepError('secret', 'the secret has no key yet');
    credentials = { apiKey, docId, turnstileSecret, buttondownKey };
  }
  return credentials;
};

const lazyStore = {};
for (const method of [
  'readStock',
  'findOrder',
  'findPerson',
  'fillPerson',
  'addPerson',
  'addOrder',
  'addLines',
  'removeOrder',
  'removePerson'
]) {
  lazyStore[method] = async (...args) => {
    const { apiKey, docId } = await readCredentials();
    const store = gristStore({ apiKey, docId, onDenied: () => (credentials = undefined) });
    return store[method](...args);
  };
}

// Fails closed: with no Turnstile secret every order is a 503 and an alarm.
const lazyVerify = async (args) => {
  const { turnstileSecret } = await readCredentials();
  if (!turnstileSecret) throw new StepError('turnstile', 'the secret has no Turnstile key');
  return turnstileVerifier({ secret: turnstileSecret, onDenied: () => (credentials = undefined) })(args);
};

// Fails open: with no Buttondown key orders go through and nobody is added.
const lazySubscribe = async (args) => {
  const { buttondownKey } = await readCredentials();
  if (!buttondownKey) return { outcome: 'skipped' };
  return buttondownSubscriber({ apiKey: buttondownKey, onDenied: () => (credentials = undefined) })(args);
};

let service;
export const handler = async (event) => {
  service ??= createService({
    store: lazyStore,
    verify: lazyVerify,
    subscribe: lazySubscribe,
    orders: {
      window: process.env.ORDERS_WINDOW,
      closes: process.env.ORDERS_CLOSES,
      goldenTicket: process.env.ORDERS_GOLDEN_TICKET === 'true'
    }
  });
  if (event?.selfCheck) {
    try {
      const stock = await service.selfCheck();
      const { turnstileSecret, buttondownKey } = await readCredentials();
      // Which keys are in the secret, never their values.
      return { ...stock, ok: stock.ok && Boolean(turnstileSecret), turnstile: Boolean(turnstileSecret), list: Boolean(buttondownKey) };
    } catch (error) {
      return { ok: false, step: error.step ?? 'unknown', status: error.status };
    }
  }
  return service.handle(event);
};
