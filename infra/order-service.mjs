// The candle order service behind things4good.xyz/api/: one Lambda function, reserved concurrency 1, so
// a stock check and the write that follows never overlap and two buyers can't get the last candle.
//
//   GET  /api/stock   what is left at the current event: products, prices, quantities. No buyer data.
//   POST /api/order   validate, re-read stock from Grist, write the order, return the total.
//
// Prices and availability come only from Grist, never from the browser. Everything the distribution
// shows as a 403 or 404 becomes the site's HTML 404 page (CustomErrorResponses), so this answers only
// with 200, 400, 405, 409, 413, 422, 429, 500 and 503.
//
// The key and the document id live in one secret, so neither is in this public repo. Logs carry
// outcomes only: no name, email, phone, note or IP, and never the text of a Grist error.

const MAKER_NIGHT = 'Maker Night candle'; // Golden Ticket: sold at the fall sale or by preorder, never here.

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
const ORDER_TYPE = 'After the sale';
const STOCK_CACHE = 'public, max-age=60, s-maxage=300';

const clean = (value) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '');

// The same format scripts/import_preorders.py gives a phone in t4g-candles.
export function formatMobile(value) {
  const typed = clean(value);
  let digits = typed.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : typed;
}

// Left is Made + Adjustment - Sold, never below zero. Golden Ticket and anything sold out stay off the
// list. Nothing about any buyer is in here: Sold is one number per product.
export function toStock(rows) {
  const events = new Set(rows.map((row) => row.event));
  if (events.size > 1) throw new StepError('stock', 'more than one current event');
  const products = rows
    .filter((row) => row.type !== MAKER_NIGHT)
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      price: Number(row.price) || 0,
      left: Math.max(0, (Number(row.made) || 0) + (Number(row.adjustment) || 0) - (Number(row.sold) || 0))
    }));
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

export function createService({
  store,
  open = false,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (entry) => (entry.level === 'error' ? console.error(entry) : console.log(entry)),
  // A known email and a new one take different numbers of Grist calls, so an order never answers
  // sooner than this, which covers both. It holds the one slot, and the page retries a 429.
  floorMs = 3000
} = {}) {
  const limiter = rateLimiter(now);

  const stockResponse = async () => {
    const { event, products } = toStock(await store.readStock());
    return json(
      200,
      { open: true, event, products: products.filter((product) => product.left > 0) },
      STOCK_CACHE
    );
  };

  const placeOrder = async (event) => {
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

    const sourceRow = `web ${order.requestId}`;
    const previous = await store.findOrder(sourceRow);
    if (previous && previous.lines > 0) return { response: json(200, { ok: true, total: previous.total }), outcome: 'duplicate', floor: true };

    if (limiter.count(`order:${ip}`) >= LIMITS.ordersPerIpPerHour || limiter.count('orders') >= LIMITS.ordersPerHour)
      return { response: json(429, { error: 'slow-down' }), outcome: 'rate-limited' };

    // An attempt that died between the order and its lines left an empty order behind.
    if (previous) await store.removeOrder(previous.id);

    const stock = toStock(await store.readStock());
    if (!stock.eventId) throw new StepError('stock', 'no current event');
    const known = new Map(stock.products.map((product) => [product.id, product]));
    if (order.items.some((item) => !known.has(item.product)))
      return { response: json(422, { error: 'unknown-product' }), outcome: 'unknown-product' };

    const short = order.items
      .map((item) => ({ item, product: known.get(item.product) }))
      .filter(({ item, product }) => item.quantity > product.left)
      .map(({ item, product }) => ({ id: product.id, name: product.name, asked: item.quantity, left: product.left }));
    if (short.length) return { response: json(409, { error: 'short', short }), outcome: 'short' };

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
        Order_Type: ORDER_TYPE,
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
    return { response: json(200, { ok: true, total }), outcome: 'created', floor: true };
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
    // Closed answers before any call to Grist.
    if (!open) return { response: json(503, { open: false }), route: isStock ? 'stock' : 'order', outcome: 'closed' };
    if (isStock) return { response: await stockResponse(), route: 'stock', outcome: 'ok' };
    return { ...(await placeOrder(event)), route: 'order' };
  };

  return {
    // Reached only by a direct invoke (npm run infra -- orders): a function URL event always carries
    // requestContext. Read only.
    async selfCheck() {
      const { event, products } = toStock(await store.readStock());
      return { ok: Boolean(event), event, products: products.filter((product) => product.left > 0).length };
    },

    async handle(event) {
      const started = now();
      let result;
      try {
        result = await route(event);
      } catch (error) {
        log({ level: 'error', outcome: 'grist-failed', step: error.step ?? 'unknown', status: error.status });
        const isOrder = event.requestContext?.http?.method === 'POST';
        result = { response: json(503, { error: 'try-again' }), route: isOrder ? 'order' : 'stock', outcome: 'grist-failed', floor: isOrder };
      }
      if (result.floor) {
        const wait = floorMs - (now() - started);
        if (wait > 0) await sleep(wait);
      }
      log({ level: 'info', route: result.route, outcome: result.outcome, status: result.response.statusCode, ms: now() - started });
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

// The real thing: credentials from Secrets Manager, read once per environment and read again if Grist
// turns the key down, so a rotated key needs no redeploy.
let credentials;
const readCredentials = async () => {
  if (!credentials) {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
    const { apiKey, docId } = JSON.parse(SecretString);
    if (!apiKey || !docId) throw new StepError('secret', 'the secret has no key yet');
    credentials = { apiKey, docId };
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
    const store = gristStore({ ...(await readCredentials()), onDenied: () => (credentials = undefined) });
    return store[method](...args);
  };
}

let service;
export const handler = async (event) => {
  service ??= createService({ store: lazyStore, open: process.env.ORDERS_OPEN === 'true' });
  if (event?.selfCheck) {
    try {
      return await service.selfCheck();
    } catch (error) {
      return { ok: false, step: error.step ?? 'unknown', status: error.status };
    }
  }
  return service.handle(event);
};
