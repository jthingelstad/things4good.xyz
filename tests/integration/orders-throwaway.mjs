// The order service against a real throwaway copy of the T4G Candles document, made-up buyers only:
//
//   GRIST_ORDER_KEY=... GRIST_ORDER_DOC=... GRIST_THROWAWAY_WORKSPACE=... npm run test:orders
//
// The key and the document id come from the command line, because neither belongs in this public repo:
// the key from 1Password (op read), the document id from the t4g-candles repo. GRIST_THROWAWAY_WORKSPACE
// is the workspace the key's own account keeps the copy in, so it never sits beside the real document.
//
// It copies the document with POST /docs/<id>/copy, sets its own stock on the copy, and deletes the copy
// whatever happens. Every write goes through a guard that refuses the live document's id. Not part of
// `npm test`: it needs a key, and it spends about 80 of the plan's 3,000 API calls a month.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, gristStore } from '../../infra/order-service.mjs';

const API = 'https://docs.getgrist.com/api';
const { GRIST_ORDER_KEY: KEY, GRIST_ORDER_DOC: LIVE_DOC, GRIST_THROWAWAY_WORKSPACE: WORKSPACE } = process.env;
if (!KEY || !LIVE_DOC || !WORKSPACE) throw new Error('Set GRIST_ORDER_KEY, GRIST_ORDER_DOC and GRIST_THROWAWAY_WORKSPACE');

const grist = async (method, path, body) => {
  // The one call that names the live document is the copy, which reads it.
  if (path !== `/docs/${LIVE_DOC}/copy`) assert.ok(!path.includes(LIVE_DOC), 'the integration test touched the live document');
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${method} ${path.replace(LIVE_DOC, '<live>')}: ${response.status}`);
  return response.json();
};

let copy; // The throwaway document's id.

// Refuses to write to anything but the copy, including through a store handed the wrong id.
const guardedFetch = async (url, init) => {
  const writes = init?.method && !url.endsWith('/sql');
  assert.ok(!url.includes(LIVE_DOC), 'the integration test touched the live document');
  if (writes) assert.ok(url.includes(`/docs/${copy}/`), 'a write to something other than the copy');
  return fetch(url, init);
};

const sql = async (query, args = []) =>
  (await grist('POST', `/docs/${copy}/sql`, { sql: query, args })).records.map((record) => record.fields);

const setStock = (updates) =>
  grist('PATCH', `/docs/${copy}/tables/Offerings/records`, {
    records: updates.map(({ offering, made, adjustment = 0 }) => ({ id: offering, fields: { Made: made, Adjustment: adjustment } }))
  });

// Turnstile and Buttondown have their own unit tests; this file is about Grist.
const passes = async () => ({ ok: true, codes: [] });

// Windows open well past this run.
const AFTER = { window: 'after', closes: '2099-01-01T00:00:00-06:00' };
const PREORDER = { window: 'preorder', closes: '2099-01-01T00:00:00-06:00', candlesOnly: true };

let offerings; // Product name -> { offering, product, sold }.
let store;
const newService = (overrides = {}) =>
  createService({ store, verify: passes, orders: AFTER, floorMs: 0, sleep: async () => {}, log: () => {}, ...overrides });

const stockEvent = { rawPath: '/api/stock', requestContext: { http: { method: 'GET' } }, headers: {} };
let address = 0;
const orderEvent = (body) => ({
  rawPath: '/api/order',
  requestContext: { http: { method: 'POST' } },
  // A fresh address each time: rate limits have their own unit tests.
  headers: { 'content-type': 'application/json', 'cloudfront-viewer-address': `203.0.113.${++address}:443` },
  body: JSON.stringify(body)
});
const buyer = (over = {}) => ({
  requestId: crypto.randomUUID(),
  name: 'Testy McTest',
  email: `testy.${crypto.randomUUID()}@example.com`,
  mobile: '612-555-0100',
  fulfillment: 'Pickup',
  note: 'Made-up order',
  website: '',
  items: [],
  ...over
});
const orderRow = async (requestId) =>
  (
    await sql(
      `select o.id, o.Sale_Order, o.Order_Type, o.Fulfillment_Method, o.Stage, o.Later, o.Total, o.Paid, o.Person,
              o.Name_As_Typed, o.Notes, o.Event, o.Causes, e.Is_Current as eventIsCurrent
         from Orders o join Events e on e.id = o.Event where o.Source_Row = ?`,
      [`web ${requestId}`]
    )
  )[0];
const counts = async () => {
  const [row] = await sql(
    'select (select count(*) from Orders) as orders, (select count(*) from Order_Lines) as lines, (select count(*) from People) as people'
  );
  return row;
};

before(async () => {
  assert.notEqual(WORKSPACE, '', 'no workspace');
  copy = await grist('POST', `/docs/${LIVE_DOC}/copy`, {
    workspaceId: Number(WORKSPACE),
    documentName: `Throwaway order test ${new Date().toISOString()}`
  });
  assert.equal(typeof copy, 'string');
  assert.notEqual(copy, LIVE_DOC);
  store = gristStore({ apiKey: KEY, docId: copy, fetch: guardedFetch });

  const rows = await sql(
    `select o.id as offering, p.id as product, p.Name as name, o.Sold as sold
       from Offerings o join Products p on p.id = o.Product join Events e on e.id = o.Event
      where e.Is_Current = 1`
  );
  offerings = Object.fromEntries(rows.map((row) => [row.name, row]));
  const left = (name, n) => ({ offering: offerings[name].offering, made: offerings[name].sold + n });
  // Deterministic stock on the copy.
  await setStock([
    left('True North', 40),
    left('Tea Time', 20),
    left('Candle Lid', 30),
    left('Winter Wonderland XL', 1),
    left('Golden Ticket', 6),
    { offering: offerings['Charcoal Rose XL'].offering, made: 0 }
  ]);
});

after(async () => {
  if (copy) await grist('DELETE', `/docs/${copy}`);
  await assert.rejects(grist('GET', `/docs/${copy}`), /404|403/, 'the throwaway copy is still there');
});

test('the copy really is a copy, and the guard would stop a write to the live document', async () => {
  assert.notEqual(copy, LIVE_DOC);
  await assert.rejects(guardedFetch(`${API}/docs/${LIVE_DOC}/tables/Orders/records`, { method: 'POST', body: '{}' }), /live document/);
});

test('stock after the sale has no buyer data, caps Golden Tickets at two an order, and leaves out anything with none left', async () => {
  const response = await newService().handle(stockEvent);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['cache-control'], /s-maxage=/);
  const { products, event } = JSON.parse(response.body);
  assert.match(event, /Candle Sale/);
  const names = products.map((p) => p.name);
  assert.ok(names.includes('True North'));
  assert.deepEqual(
    (({ left, limit }) => ({ left, limit }))(products.find((p) => p.name === 'Golden Ticket')),
    { left: 6, limit: 2 }
  );
  assert.ok(!names.includes('Charcoal Rose XL'));
  assert.equal(products.find((p) => p.name === 'Winter Wonderland XL').left, 1);
  assert.equal(products.find((p) => p.name === 'True North').left, 40);
  assert.equal(products.find((p) => p.name === 'True North').price, 25);
  for (const product of products) assert.deepEqual(Object.keys(product).sort(), ['id', 'left', 'limit', 'name', 'price', 'type']);
  // Nothing in it matches an email address or a phone number.
  assert.ok(!/@|\(\d{3}\)/.test(response.body));
});

test('a new buyer: person, order and lines land as the document expects', async () => {
  const before = await counts();
  const typed = buyer({
    name: 'Testy New',
    items: [
      { product: offerings['True North'].product, quantity: 2 },
      { product: offerings['Candle Lid'].product, quantity: 1 }
    ]
  });
  const response = await newService().handle(orderEvent(typed));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, total: 60 });

  const row = await orderRow(typed.requestId);
  assert.equal(row.Total, 60);
  assert.equal(row.Order_Type, 'After the sale');
  assert.equal(row.Fulfillment_Method, 'Pickup');
  assert.equal(row.Stage, 'Waiting on payment');
  assert.ok(!row.Later, 'pickup is not Later delivery');
  assert.ok(!row.Paid);
  assert.equal(row.Name_As_Typed, 'Testy New');
  assert.equal(row.Notes, 'Made-up order');
  assert.equal(row.eventIsCurrent, 1);
  assert.ok(row.Sale_Order > 0);

  const [person] = await sql('select Name, Type, Email, Mobile, Notes from People where id = ?', [row.Person]);
  assert.deepEqual(person, { Name: 'Testy New', Type: 'Person', Email: typed.email, Mobile: '(612) 555-0100', Notes: 'Added by the order form' });

  const after = await counts();
  assert.deepEqual(after, { orders: before.orders + 1, lines: before.lines + 2, people: before.people + 1 });

  // Stock falls straight away.
  const stock = JSON.parse((await newService().handle(stockEvent)).body).products;
  assert.equal(stock.find((p) => p.name === 'True North').left, 38);
});

test('SPS delivery shows on Later delivery', async () => {
  const typed = buyer({ fulfillment: 'SPS delivery', items: [{ product: offerings['Tea Time'].product, quantity: 1 }] });
  assert.equal((await newService().handle(orderEvent(typed))).statusCode, 200);
  const row = await orderRow(typed.requestId);
  assert.equal(row.Fulfillment_Method, 'SPS delivery');
  assert.equal(row.Stage, 'Waiting on payment');
  assert.ok(row.Later);
});

test('Sale_Order numbers come out consecutive, left to the trigger', async () => {
  const numbers = [];
  for (let n = 0; n < 3; n++) {
    const typed = buyer({ items: [{ product: offerings['Tea Time'].product, quantity: 1 }] });
    assert.equal((await newService().handle(orderEvent(typed))).statusCode, 200);
    numbers.push((await orderRow(typed.requestId)).Sale_Order);
  }
  assert.equal(numbers[1], numbers[0] + 1);
  assert.equal(numbers[2], numbers[1] + 1);
});

test('oversold: names what is short and writes nothing', async () => {
  const before = await counts();
  const typed = buyer({
    items: [
      { product: offerings['Winter Wonderland XL'].product, quantity: 2 },
      { product: offerings['True North'].product, quantity: 1 }
    ]
  });
  const response = await newService().handle(orderEvent(typed));
  assert.equal(response.statusCode, 409);
  const { short } = JSON.parse(response.body);
  assert.equal(short.length, 1);
  assert.equal(short[0].name, 'Winter Wonderland XL');
  assert.equal(short[0].left, 1);
  assert.deepEqual(await counts(), before);
});

test('a double submit writes one order and answers the same total', async () => {
  const before = await counts();
  const typed = buyer({ items: [{ product: offerings['True North'].product, quantity: 3 }] });
  const service = newService();
  const first = await service.handle(orderEvent(typed));
  const second = await service.handle(orderEvent(typed));
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  assert.deepEqual(JSON.parse(first.body), { ok: true, total: 75 });
  const after = await counts();
  assert.deepEqual(after, { orders: before.orders + 1, lines: before.lines + 1, people: before.people + 1 });
});

test('an order left with no lines by a dead attempt is replaced', async () => {
  const typed = buyer({ items: [{ product: offerings['True North'].product, quantity: 1 }] });
  await grist('POST', `/docs/${copy}/tables/Orders/records`, {
    records: [{ fields: { Source_Row: `web ${typed.requestId}`, Name_As_Typed: 'Dead attempt', Order_Type: 'After the sale' } }]
  });
  const response = await newService().handle(orderEvent(typed));
  assert.equal(response.statusCode, 200);
  const rows = await sql('select id, Name_As_Typed from Orders where Source_Row = ?', [`web ${typed.requestId}`]);
  // Grist can give a removed row's id to the next one, so the name is what tells them apart.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Name_As_Typed, typed.name);
});

test('the spam trap writes nothing', async () => {
  const before = await counts();
  const response = await newService().handle(orderEvent(buyer({ website: 'https://spam.example', items: [{ product: offerings['True North'].product, quantity: 1 }] })));
  assert.equal(response.statusCode, 422);
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid', fields: [] });
  assert.deepEqual(await counts(), before);
});

test('an unknown product, and the Golden Ticket under candlesOnly, are refused, and nothing is written', async () => {
  const before = await counts();
  for (const [orders, product] of [[AFTER, 999999], [PREORDER, offerings['Golden Ticket'].product]]) {
    const response = await newService({ orders }).handle(orderEvent(buyer({ items: [{ product, quantity: 1 }] })));
    assert.equal(response.statusCode, 422);
    assert.equal(JSON.parse(response.body).error, 'unknown-product');
  }
  assert.deepEqual(await counts(), before);
});

test('a preorder: regular candles past what is poured, written as a Preorder', async () => {
  const service = newService({ orders: PREORDER });
  const stock = JSON.parse((await service.handle(stockEvent)).body);
  assert.equal(stock.window, 'preorder');
  assert.ok(stock.products.length > 0 && stock.products.every((p) => p.type === 'Candle' && p.left === null && p.limit === 24));
  // Tea Time has 20 left on the copy.
  const typed = buyer({ items: [{ product: offerings['Tea Time'].product, quantity: 24 }] });
  const response = await service.handle(orderEvent(typed));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, total: 600 });
  const row = await orderRow(typed.requestId);
  assert.equal(row.Order_Type, 'Preorder');
  assert.equal(row.Total, 600);
  assert.ok(!row.Paid);
});

test('a known email: linked, details kept, blanks filled, and the answer looks just like a new one', async () => {
  const email = `known.${crypto.randomUUID()}@example.com`;
  const added = await grist('POST', `/docs/${copy}/tables/People/records`, {
    records: [{ fields: { Name: 'Made Up Known', Type: 'Person', Email: email, Notes: 'Keep this note' } }]
  });
  const id = added.records[0].id;
  const items = [{ product: offerings['True North'].product, quantity: 1 }];
  const knownBuyer = buyer({ name: 'Someone Else', email: email.toUpperCase(), items });
  const knownAnswer = await newService().handle(orderEvent(knownBuyer));
  const newAnswer = await newService().handle(orderEvent(buyer({ items })));
  assert.deepEqual(knownAnswer, newAnswer);

  const row = await orderRow(knownBuyer.requestId);
  assert.equal(row.Person, id);
  assert.equal(row.Name_As_Typed, 'Someone Else');
  const [person] = await sql('select Name, Email, Mobile, Notes from People where id = ?', [id]);
  assert.deepEqual(person, { Name: 'Made Up Known', Email: email, Mobile: '(612) 555-0100', Notes: 'Keep this note' });

  // A later order with another phone changes nothing, now the phone isn't blank.
  await newService().handle(orderEvent(buyer({ email, mobile: '952-555-0199', items })));
  const [again] = await sql('select Mobile from People where id = ?', [id]);
  assert.equal(again.Mobile, '(612) 555-0100');
});

test('when the lines fail the order and the new person come back out', async () => {
  const before = await counts();
  const failing = { ...store, addLines: async () => { throw Object.assign(new Error('boom'), { step: 'add-lines' }); } };
  const logged = [];
  const service = createService({ store: failing, verify: passes, orders: AFTER, floorMs: 0, sleep: async () => {}, log: (entry) => logged.push(entry) });
  const typed = buyer({ items: [{ product: offerings['True North'].product, quantity: 1 }] });
  const response = await service.handle(orderEvent(typed));
  assert.equal(response.statusCode, 503);
  assert.deepEqual(await counts(), before);
  assert.equal(await orderRow(typed.requestId), undefined);
  assert.ok(logged.some((entry) => entry.outcome === 'rolled-back'));
});

test('the last candle goes to the first buyer; the next one is told', async () => {
  await setStock([{ offering: offerings['Winter Wonderland XL'].offering, made: offerings['Winter Wonderland XL'].sold + 1 }]);
  const items = [{ product: offerings['Winter Wonderland XL'].product, quantity: 1 }];
  assert.equal((await newService().handle(orderEvent(buyer({ items })))).statusCode, 200);
  const second = await newService().handle(orderEvent(buyer({ items })));
  assert.equal(second.statusCode, 409);
  assert.equal(JSON.parse(second.body).short[0].left, 0);
  const stock = JSON.parse((await newService().handle(stockEvent)).body).products;
  assert.ok(!stock.some((p) => p.name === 'Winter Wonderland XL'));
});

test('the order shows on the pick-list formulas, and an unpaid one holds stock', async () => {
  const typed = buyer({ items: [{ product: offerings['Tea Time'].product, quantity: 1 }] });
  await newService().handle(orderEvent(typed));
  const row = await orderRow(typed.requestId);
  const [offering] = await sql('select Sold, Left from Offerings where id = ?', [offerings['Tea Time'].offering]);
  assert.ok(offering.Sold > offerings['Tea Time'].sold);
  assert.equal(offering.Left, offerings['Tea Time'].sold + 20 - offering.Sold);
  assert.ok(!row.Paid);
});
