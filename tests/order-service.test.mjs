// The order service against a pretend Grist. tests/integration/orders-throwaway.mjs runs the same rules
// against a real throwaway copy of the document (npm run test:orders).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buttondownSubscriber,
  createService,
  currentWindow,
  formatMobile,
  gristStore,
  LIMITS,
  toSeats,
  toStock,
  turnstileVerifier
} from '../infra/order-service.mjs';

const ROWS = [
  { eventId: 7, event: '2026 Candle Sale', id: 3, name: 'True North', type: 'Candle', price: 25, made: 10, adjustment: null, sold: 4 },
  { eventId: 7, event: '2026 Candle Sale', id: 4, name: 'Apple Of My Eye', type: 'Candle', price: 25, made: 5, adjustment: -1, sold: 2 },
  { eventId: 7, event: '2026 Candle Sale', id: 13, name: 'Winter Wonderland XL', type: 'XL candle', price: 50, made: 1, adjustment: 0, sold: 0 },
  { eventId: 7, event: '2026 Candle Sale', id: 16, name: 'Candle Lid', type: 'Lid', price: 10, made: 69, adjustment: null, sold: 1 },
  { eventId: 7, event: '2026 Candle Sale', id: 15, name: 'Golden Ticket', type: 'Maker Night candle', price: 250, made: 6, adjustment: null, sold: 0 },
  { eventId: 7, event: '2026 Candle Sale', id: 22, name: 'Charcoal Rose XL', type: 'XL candle', price: 50, made: 0, adjustment: 0, sold: 0 }
];

// A pretend Grist: the store's named calls over arrays, recording every call.
function fakeStore({ people = [], fail = {} } = {}) {
  const rows = ROWS.map((row) => ({ ...row }));
  const state = { people: people.map((p) => ({ ...p })), orders: [], lines: [], calls: [] };
  const record = (name, fn) => async (...args) => {
    state.calls.push(name);
    if (fail[name]) {
      const error = new Error('boom');
      error.step = name;
      error.status = 500;
      throw error;
    }
    return fn(...args);
  };
  return {
    state,
    readStock: record('readStock', async () => rows.map((row) => ({ ...row }))),
    findOrder: record('findOrder', async (sourceRow) => {
      const order = state.orders.find((o) => o.Source_Row === sourceRow);
      if (!order) return null;
      const lines = state.lines.filter((l) => l.Order === order.id);
      const total = lines.reduce((sum, l) => sum + l.Quantity * rows.find((r) => r.id === l.Product).price, 0);
      return { id: order.id, total, lines: lines.length };
    }),
    findPerson: record('findPerson', async (email) => {
      const person = state.people.find((p) => (p.Email ?? '').toLowerCase() === email);
      return person ? { id: person.id, name: person.Name, mobile: person.Mobile } : null;
    }),
    fillPerson: record('fillPerson', async (id, fields) => Object.assign(state.people.find((p) => p.id === id), fields)),
    addPerson: record('addPerson', async (fields) => {
      const id = 1000 + state.people.length;
      state.people.push({ id, ...fields });
      return id;
    }),
    addOrder: record('addOrder', async (fields) => {
      const id = 500 + state.orders.length;
      state.orders.push({ id, ...fields });
      return id;
    }),
    addLines: record('addLines', async (lines) => {
      for (const line of lines) {
        state.lines.push(line);
        rows.find((r) => r.id === line.Product).sold += line.Quantity;
      }
    }),
    removeOrder: record('removeOrder', async (id) => {
      state.orders = state.orders.filter((o) => o.id !== id);
      state.lines = state.lines.filter((l) => l.Order !== id);
    }),
    removePerson: record('removePerson', async (id) => {
      state.people = state.people.filter((p) => p.id !== id);
    })
  };
}

const WRITES = ['fillPerson', 'addPerson', 'addOrder', 'addLines', 'removeOrder', 'removePerson'];
const writesIn = (store) => store.state.calls.filter((call) => WRITES.includes(call));

// The clock starts at 1_800_000_000_000 (2027-01-15), well before these windows close.
const CLOSES = '2027-01-20T23:59:00-06:00';
// Grist's names for the causes, as causes.json's `grist` gives them.
const CAUSES = ["Cure Alzheimer's", 'Bridging', 'Wilderness Canoe Base', 'Physicians for NHP'];
const AFTER = { window: 'after', closes: CLOSES, goldenTicket: true, causes: CAUSES };
const PREORDER = { window: 'preorder', closes: CLOSES, causes: CAUSES };
const CLOSED = { window: 'closed' };

// Turnstile passes any token but 'bad'; the list adds everyone. Each records what it was asked.
function setup({ orders = AFTER, people, fail, verify, subscribe } = {}) {
  const store = fakeStore({ people, fail });
  const logs = [];
  const clock = { time: 1_800_000_000_000 };
  const naps = [];
  const checks = [];
  const joins = [];
  const service = createService({
    store,
    verify: async (args) => {
      checks.push(args);
      if (verify) return verify(args);
      return args.token === 'bad' ? { ok: false, codes: ['invalid-input-response'] } : { ok: true, codes: [] };
    },
    subscribe: async (args) => {
      joins.push(args);
      return subscribe ? subscribe(args) : { outcome: 'added' };
    },
    orders,
    now: () => clock.time,
    sleep: async (ms) => {
      naps.push(ms);
      clock.time += ms;
    },
    log: (entry) => logs.push(entry)
  });
  return { store, service, logs, clock, naps, checks, joins };
}

const get = (path = '/api/stock') => ({ rawPath: path, requestContext: { http: { method: 'GET' } }, headers: {} });
const post = (body, { ip = '198.51.100.10:443', contentType = 'application/json', raw } = {}) => ({
  rawPath: '/api/order',
  requestContext: { http: { method: 'POST' } },
  headers: { 'content-type': contentType, 'cloudfront-viewer-address': ip },
  body: raw ?? JSON.stringify(body)
});
const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const order = (over = {}) => ({
  requestId: uuid(),
  name: 'Testy McTest',
  email: 'testy@example.com',
  mobile: '612-555-0100',
  fulfillment: 'Pickup',
  note: 'Leave them on the porch',
  website: '',
  items: [{ product: 3, quantity: 2 }, { product: 16, quantity: 1 }],
  ...over
});
const parse = (response) => JSON.parse(response.body);

test('closed: stock and order both answer 503 before any call to Grist', async () => {
  const { service, store } = setup({ orders: CLOSED });
  for (const event of [get(), post(order())]) {
    const response = await service.handle(event);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(parse(response), { open: false, window: 'closed' });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(store.state.calls, []);
});

test('stock after the sale: quantities left, two Golden Tickets an order, nothing sold out, nothing about any buyer, cached a few minutes', async () => {
  const { service } = setup();
  const response = await service.handle(get());
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['cache-control'], /s-maxage=300/);
  const body = parse(response);
  assert.equal(body.event, '2026 Candle Sale');
  assert.equal(body.window, 'after');
  assert.equal(body.closes, CLOSES);
  assert.deepEqual(
    body.products.map((p) => [p.name, p.left, p.limit]),
    [['True North', 6, 6], ['Apple Of My Eye', 2, 2], ['Winter Wonderland XL', 1, 1], ['Candle Lid', 68, 24], ['Golden Ticket', 6, 2]]
  );
  for (const product of body.products) assert.deepEqual(Object.keys(product).sort(), ['id', 'left', 'limit', 'name', 'price', 'type']);
});

test('stock before the sale: regular candles have no count, the rest are capped, and Golden Tickets wait for their switch', async () => {
  const body = parse(await setup({ orders: PREORDER }).service.handle(get()));
  assert.equal(body.window, 'preorder');
  assert.deepEqual(
    body.products.map((p) => [p.name, p.left, p.limit]),
    [['True North', null, 24], ['Apple Of My Eye', null, 24], ['Winter Wonderland XL', 1, 1], ['Candle Lid', 68, 24]]
  );
  const all = parse(await setup({ orders: { ...PREORDER, goldenTicket: true } }).service.handle(get()));
  assert.deepEqual(
    all.products.map((p) => [p.name, p.left, p.limit]),
    [['True North', null, 24], ['Apple Of My Eye', null, 24], ['Winter Wonderland XL', 1, 1], ['Candle Lid', 68, 24], ['Golden Ticket', 6, 2]]
  );
});

test('a window shuts on time with no deploy: preorders pause, the leftovers week closes', async () => {
  for (const [orders, next] of [[PREORDER, 'paused'], [AFTER, 'closed']]) {
    const { service, store, clock } = setup({ orders });
    assert.equal((await service.handle(get())).statusCode, 200);
    clock.time = Date.parse(CLOSES);
    const calls = store.state.calls.length;
    for (const event of [get(), post(order())]) {
      const response = await service.handle(event);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(parse(response), { open: false, window: next });
    }
    assert.equal(store.state.calls.length, calls);
  }
});

test('the window: open ones run until they close, and anything unclear is shut', () => {
  const at = Date.parse('2026-11-08T12:00:00-06:00');
  const closes = '2026-11-08T23:59:00-06:00';
  assert.equal(currentWindow({ window: 'preorder', closes }, at), 'preorder');
  assert.equal(currentWindow({ window: 'preorder', closes }, Date.parse(closes)), 'paused');
  assert.equal(currentWindow({ window: 'after', closes }, at), 'after');
  assert.equal(currentWindow({ window: 'after', closes }, Date.parse(closes) + 1), 'closed');
  assert.equal(currentWindow({ window: 'paused', closes }, at), 'paused');
  assert.equal(currentWindow({ window: 'closed' }, at), 'closed');
  assert.equal(currentWindow({ window: 'preorder' }, at), 'paused');
  assert.equal(currentWindow({ window: 'preorder', closes: 'Sunday night' }, at), 'paused');
  assert.equal(currentWindow({ window: 'after', closes: '' }, at), 'closed');
  assert.equal(currentWindow({ window: 'open', closes }, at), 'closed');
  assert.equal(currentWindow({ window: 'constructor', closes }, at), 'closed');
  assert.equal(currentWindow(undefined, at), 'closed');
});

test('left never goes below zero', () => {
  const [row] = toStock([{ eventId: 7, event: 'x', id: 1, name: 'a', type: 'Candle', price: 25, made: 2, adjustment: -1, sold: 9 }]).products;
  assert.equal(row.left, 0);
});

test('a new buyer gets a person, one order and its lines, and the total comes from Grist prices', async () => {
  const { service, store } = setup();
  // A browser's idea of a price is not even read.
  const response = await service.handle(post(order({ total: 1, items: [{ product: 3, quantity: 2, price: 1 }, { product: 16, quantity: 1 }] })));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse(response), { ok: true, total: 60 });
  const { people, orders, lines } = store.state;
  assert.equal(people.length, 1);
  assert.deepEqual(
    { Name: people[0].Name, Type: people[0].Type, Email: people[0].Email, Mobile: people[0].Mobile },
    { Name: 'Testy McTest', Type: 'Person', Email: 'testy@example.com', Mobile: '(612) 555-0100' }
  );
  assert.equal(orders.length, 1);
  const [saved] = orders;
  assert.equal(saved.Event, 7);
  assert.equal(saved.Person, people[0].id);
  assert.equal(saved.Name_As_Typed, 'Testy McTest');
  assert.equal(saved.Order_Type, 'After the sale');
  assert.equal(saved.Payment_Link_Sent, true);
  assert.equal(saved.Fulfillment_Method, 'Pickup');
  assert.equal(saved.Source_Row, `web ${uuid()}`);
  assert.equal(saved.Notes, 'Leave them on the porch');
  assert.equal(saved.Paid, false);
  assert.equal(saved.Ordered_At, 1_800_000_000);
  // Left to the document: Sale_Order to its trigger, and Causes blank for the even split when the
  // page sends none.
  assert.ok(!('Sale_Order' in saved) && !('Causes' in saved));
  assert.deepEqual(lines, [
    { Order: saved.id, Product: 3, Quantity: 2 },
    { Order: saved.id, Product: 16, Quantity: 1 }
  ]);
});

test('causes: every one checked leaves Causes blank, fewer are written in this year\'s order', async () => {
  const cases = [
    [undefined, undefined], // A page from before the choice.
    [[...CAUSES].reverse(), undefined],
    [['Physicians for NHP', 'Bridging'], ['L', 'Bridging', 'Physicians for NHP']],
    [["Cure Alzheimer's"], ['L', "Cure Alzheimer's"]]
  ];
  for (const [causes, written] of cases) {
    const { service, store } = setup();
    const response = await service.handle(post(order({ causes })));
    assert.equal(response.statusCode, 200, JSON.stringify(causes));
    const [saved] = store.state.orders;
    assert.deepEqual(saved.Causes, written, JSON.stringify(causes));
    assert.equal('Causes' in saved, written !== undefined);
  }
});

test('causes: with none configured, a pick is refused rather than dropped', async () => {
  const { service, store } = setup({ orders: { ...AFTER, causes: [] } });
  const response = await service.handle(post(order({ causes: ['Bridging'] })));
  assert.equal(response.statusCode, 422);
  assert.deepEqual(parse(response).fields, ['causes']);
  assert.deepEqual(store.state.calls, []);
  // An old page, which sends none, still gets through.
  assert.equal((await setup({ orders: { ...AFTER, causes: [] } }).service.handle(post(order()))).statusCode, 200);
});

test('oversold: names what is short and writes nothing', async () => {
  const { service, store } = setup();
  const response = await service.handle(post(order({ items: [{ product: 3, quantity: 7 }, { product: 16, quantity: 1 }] })));
  assert.equal(response.statusCode, 409);
  assert.deepEqual(parse(response), { error: 'short', short: [{ id: 3, name: 'True North', asked: 7, left: 6 }] });
  assert.deepEqual(writesIn(store), []);
});

test('the last candle goes to one buyer: the next is told it is gone', async () => {
  const { service } = setup();
  const items = [{ product: 13, quantity: 1 }];
  assert.equal((await service.handle(post(order({ requestId: uuid(1), items })))).statusCode, 200);
  const second = await service.handle(post(order({ requestId: uuid(2), items, email: 'other@example.com' }), { ip: '198.51.100.11:443' }));
  assert.equal(second.statusCode, 409);
  assert.equal(parse(second).short[0].left, 0);
});

test('a product nobody can buy here is refused: unknown, or a Golden Ticket with its switch off', async () => {
  for (const [orders, product] of [[AFTER, 999], [PREORDER, 15], [{ ...AFTER, goldenTicket: false }, 15]]) {
    const { service, store } = setup({ orders });
    const response = await service.handle(post(order({ items: [{ product, quantity: 1 }] })));
    assert.equal(response.statusCode, 422);
    assert.equal(parse(response).error, 'unknown-product');
    assert.deepEqual(writesIn(store), []);
  }
});

test('a preorder takes more candles than are poured, and says so in Order_Type', async () => {
  const { service, store } = setup({ orders: PREORDER });
  const response = await service.handle(post(order({ items: [{ product: 3, quantity: 20 }] })));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(parse(response), { ok: true, total: 500 });
  const [saved] = store.state.orders;
  assert.equal(saved.Order_Type, 'Preorder');
  // The done screen links to /pay/, so the order is past Stage "Send link".
  assert.equal(saved.Payment_Link_Sent, true);
  assert.deepEqual(store.state.lines, [{ Order: saved.id, Product: 3, Quantity: 20 }]);
});

test('a preorder caps what is not poured to order', async () => {
  const { service, store } = setup({ orders: PREORDER });
  const response = await service.handle(post(order({ items: [{ product: 3, quantity: 10 }, { product: 13, quantity: 2 }] })));
  assert.equal(response.statusCode, 409);
  assert.deepEqual(parse(response).short, [{ id: 13, name: 'Winter Wonderland XL', asked: 2, left: 1 }]);
  assert.deepEqual(writesIn(store), []);
});

test('Golden Tickets sell two to an order while seats remain', async () => {
  const { service, store } = setup();
  const three = await service.handle(post(order({ requestId: uuid(1), items: [{ product: 15, quantity: 3 }] })));
  assert.equal(three.statusCode, 422);
  assert.deepEqual(parse(three), { error: 'invalid', fields: ['items'] });
  assert.deepEqual(writesIn(store), []);
  const two = await service.handle(post(order({ requestId: uuid(2), items: [{ product: 15, quantity: 2 }] })));
  assert.equal(two.statusCode, 200);
  assert.deepEqual(parse(two), { ok: true, total: 500 });
  assert.equal(store.state.orders[0].Order_Type, 'After the sale');
});

test('the spam trap refuses generically, before any call to Grist', async () => {
  const { service, store } = setup();
  const response = await service.handle(post(order({ website: 'https://spam.example' })));
  assert.equal(response.statusCode, 422);
  assert.deepEqual(parse(response), { error: 'invalid', fields: [] });
  assert.deepEqual(store.state.calls, []);
});

test('a double submit writes once and answers the same total', async () => {
  const { service, store } = setup();
  const first = await service.handle(post(order()));
  const second = await service.handle(post(order()));
  assert.deepEqual(parse(second), parse(first));
  assert.equal(store.state.orders.length, 1);
  assert.equal(store.state.lines.length, 2);
});

test('an attempt that died before its lines is replaced, not answered as done', async () => {
  const { service, store } = setup();
  store.state.orders.push({ id: 400, Source_Row: `web ${uuid()}` });
  const response = await service.handle(post(order()));
  assert.equal(response.statusCode, 200);
  assert.equal(store.state.orders.length, 1);
  assert.notEqual(store.state.orders[0].id, 400);
  assert.equal(store.state.lines.length, 2);
});

test('a known email links the order, fills only blanks, and looks exactly like a new one', async () => {
  const known = { id: 7, Name: 'Real Name', Email: 'testy@example.com', Mobile: '', Notes: 'Lives next door' };
  const a = setup({ people: [known] });
  const b = setup();
  const typed = order({ name: 'Somebody Else', email: 'TESTY@example.com' });
  const knownAnswer = await a.service.handle(post(typed));
  const newAnswer = await b.service.handle(post(typed));

  // Status, headers, body and how long it took.
  assert.deepEqual(knownAnswer, newAnswer);
  assert.deepEqual(a.naps, [3000]);
  assert.deepEqual(b.naps, [3000]);

  const [person] = a.store.state.people;
  assert.equal(a.store.state.people.length, 1);
  assert.equal(person.Name, 'Real Name');
  assert.equal(person.Notes, 'Lives next door');
  assert.equal(person.Mobile, '(612) 555-0100'); // It was blank.
  assert.equal(a.store.state.orders[0].Person, 7);
  assert.equal(a.store.state.orders[0].Name_As_Typed, 'Somebody Else');
});

test('a person with nothing blank is not written to at all', async () => {
  const { service, store } = setup({ people: [{ id: 7, Name: 'Real Name', Email: 'testy@example.com', Mobile: '(612) 555-9999' }] });
  await service.handle(post(order()));
  assert.ok(!store.state.calls.includes('fillPerson'));
  assert.equal(store.state.people[0].Mobile, '(612) 555-9999');
});

test('email matches exactly: a different address is a different person', async () => {
  const { service, store } = setup({ people: [{ id: 7, Name: 'Real Name', Email: 'testy@example.com' }] });
  await service.handle(post(order({ email: 'testy2@example.com' })));
  assert.equal(store.state.people.length, 2);
  assert.notEqual(store.state.orders[0].Person, 7);
});

test('when the lines fail the order comes back out, and a person made for it too; the page can retry', async () => {
  const { service, store, logs } = setup({ fail: { addLines: true } });
  const response = await service.handle(post(order()));
  assert.equal(response.statusCode, 503);
  assert.deepEqual(parse(response), { error: 'try-again' });
  assert.deepEqual(store.state.orders, []);
  assert.deepEqual(store.state.people, []);
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.outcome === 'rolled-back'));
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.step === 'addLines'));
});

test('when the lines fail a known person stays', async () => {
  const { service, store } = setup({ people: [{ id: 7, Name: 'Real Name', Email: 'testy@example.com' }], fail: { addLines: true } });
  await service.handle(post(order()));
  assert.equal(store.state.people.length, 1);
  assert.deepEqual(store.state.orders, []);
});

test('input limits', async () => {
  const cases = [
    [{ requestId: 'not-a-uuid' }, 'requestId'],
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(LIMITS.name + 1) }, 'name'],
    [{ email: 'nope' }, 'email'],
    [{ email: `${'x'.repeat(LIMITS.email)}@example.com` }, 'email'],
    [{ mobile: 'call me maybe' }, 'mobile'],
    [{ mobile: '1'.repeat(LIMITS.mobile + 1) }, 'mobile'],
    [{ mobile: '' }, 'mobile'],
    [{ mobile: undefined }, 'mobile'],
    [{ mobile: '+()' }, 'mobile'],
    [{ mobile: '555-01' }, 'mobile'],
    [{ fulfillment: 'Carrier pigeon' }, 'fulfillment'],
    [{ causes: [] }, 'causes'],
    [{ causes: 'Bridging' }, 'causes'],
    [{ causes: null }, 'causes'],
    [{ causes: ['Bridging', 'Bridging'] }, 'causes'],
    [{ causes: ['Bridging', 'Save the Snakes'] }, 'causes'],
    [{ causes: ['bridging'] }, 'causes'],
    [{ causes: [7] }, 'causes'],
    [{ note: 'x'.repeat(LIMITS.note + 1) }, 'note'],
    [{ items: [] }, 'items'],
    [{ items: 'lots' }, 'items'],
    [{ items: [{ product: 3, quantity: 0 }] }, 'items'],
    [{ items: [{ product: 3, quantity: 1.5 }] }, 'items'],
    [{ items: [{ product: 3, quantity: LIMITS.lineQuantity + 1 }] }, 'items'],
    [{ items: [{ product: '3', quantity: 1 }] }, 'items'],
    [{ items: [{ product: 3, quantity: 1 }, { product: 3, quantity: 1 }] }, 'items'],
    [{ items: [{ product: 3, quantity: 24 }, { product: 16, quantity: 7 }] }, 'items']
  ];
  for (const [over, field] of cases) {
    const { service, store } = setup();
    const response = await service.handle(post(order(over)));
    assert.equal(response.statusCode, 422, JSON.stringify(over).slice(0, 60));
    assert.ok(parse(response).fields.includes(field), field);
    assert.deepEqual(store.state.calls, []);
  }
});

test('a body too big, not JSON, or not declared as JSON is refused before Grist', async () => {
  const { service, store } = setup();
  assert.equal((await service.handle(post(null, { raw: 'x'.repeat(LIMITS.bodyBytes + 1) }))).statusCode, 413);
  assert.equal((await service.handle(post(null, { raw: '{nope' }))).statusCode, 400);
  assert.equal((await service.handle(post(null, { raw: '[1]' }))).statusCode, 400);
  assert.equal((await service.handle(post(order(), { contentType: 'text/plain' }))).statusCode, 400);
  assert.deepEqual(store.state.calls, []);
});

test('a base64 body from the function URL is read', async () => {
  const { service } = setup();
  const event = post(order());
  event.body = Buffer.from(event.body).toString('base64');
  event.isBase64Encoded = true;
  assert.equal((await service.handle(event)).statusCode, 200);
});

test('rate limits: orders per address, tries per address, and orders overall, each over an hour', async () => {
  const perIp = setup();
  const items = [{ product: 16, quantity: 1 }];
  for (let n = 1; n <= LIMITS.ordersPerIpPerHour; n++)
    assert.equal((await perIp.service.handle(post(order({ requestId: uuid(n), items })))).statusCode, 200);
  const limited = await perIp.service.handle(post(order({ requestId: uuid(50), items })));
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(parse(limited), { error: 'slow-down' });
  // Another address is fine, and a retry of an order already taken still gets its answer.
  assert.equal((await perIp.service.handle(post(order({ requestId: uuid(51), items }), { ip: '[2001:db8::1]:443' }))).statusCode, 200);
  assert.equal((await perIp.service.handle(post(order({ requestId: uuid(1), items })))).statusCode, 200);
  // An hour later the address is welcome again.
  perIp.clock.time += 3_600_001;
  assert.equal((await perIp.service.handle(post(order({ requestId: uuid(52), items })))).statusCode, 200);

  const tries = setup();
  for (let n = 0; n < LIMITS.attemptsPerIpPerHour; n++)
    assert.equal((await tries.service.handle(post(order({ email: 'nope' })))).statusCode, 422);
  assert.equal((await tries.service.handle(post(order()))).statusCode, 429);
  assert.deepEqual(tries.store.state.calls, []);

  const overall = setup();
  for (let n = 1; n <= LIMITS.ordersPerHour; n++)
    assert.equal((await overall.service.handle(post(order({ requestId: uuid(n), items }), { ip: `198.51.100.${n}:443` }))).statusCode, 200);
  assert.equal((await overall.service.handle(post(order({ requestId: uuid(99), items }), { ip: '198.51.100.200:443' }))).statusCode, 429);
});

test('logs carry outcomes only: no buyer details, no address, on any path', async () => {
  const known = [{ id: 7, Name: 'Real Name', Email: 'kept@example.com', Mobile: '' }];
  const secrets = ['Testy', 'testy@example.com', '555-0100', '555) 0100', 'porch', '198.51.100.10', 'kept@example.com', 'Real Name', 'tok-sekrit'];
  const runs = [
    setup({ people: known }),
    setup({ fail: { addLines: true } }),
    setup({ fail: { addOrder: true } }),
    setup({ fail: { readStock: true } })
  ];
  for (const { service, logs } of runs) {
    await service.handle(get());
    await service.handle(post(order({ turnstile: 'tok-sekrit' })));
    await service.handle(post(order({ requestId: uuid(2), email: 'kept@example.com' })));
    await service.handle(post(order({ requestId: uuid(3), items: [{ product: 3, quantity: 24 }] })));
    await service.handle(post(order({ requestId: uuid(4), website: 'spam' })));
    await service.handle(post(order({ requestId: uuid(5), email: 'nope' })));
    assert.ok(logs.length > 0);
    const text = JSON.stringify(logs);
    for (const secret of secrets) assert.ok(!text.includes(secret), secret);
  }
});

test('anything else is a 405, never a 403 or 404 that CloudFront would turn into the HTML page', async () => {
  const { service } = setup();
  for (const event of [
    get('/api/nope'),
    get('/api/order'),
    { rawPath: '/api/stock', requestContext: { http: { method: 'POST' } }, headers: {}, body: '{}' },
    { rawPath: '/api/order', requestContext: { http: { method: 'OPTIONS' } }, headers: {} },
    { rawPath: '/api/seats', requestContext: { http: { method: 'POST' } }, headers: {}, body: '{}' }
  ])
    assert.equal((await service.handle(event)).statusCode, 405);
});

test('a Grist failure on stock is a retryable 503 and an error in the logs', async () => {
  const { service, logs, naps } = setup({ fail: { readStock: true } });
  const response = await service.handle(get());
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(logs.some((entry) => entry.level === 'error'));
  assert.deepEqual(naps, []); // Only an order waits out the floor.
});

test('seats: the Golden Ticket count in every window, cached a few minutes, nothing about any buyer', async () => {
  for (const orders of [CLOSED, PREORDER, AFTER, { window: 'paused' }]) {
    const { service, store } = setup({ orders });
    const response = await service.handle(get('/api/seats'));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(parse(response), { event: '2026 Candle Sale', total: 6, left: 6 });
    assert.match(response.headers['cache-control'], /s-maxage=300/);
    assert.deepEqual(store.state.calls, ['readStock']);
  }
  // An order for two takes two seats: the count is the one the form sells against.
  const { service } = setup();
  await service.handle(post(order({ items: [{ product: 15, quantity: 2 }] })));
  assert.deepEqual(parse(await service.handle(get('/api/seats'))), { event: '2026 Candle Sale', total: 6, left: 4 });
});

test('seats: Made + Adjustment is the total, never below zero left, and none without a Golden Ticket', () => {
  const ticket = ROWS.find((row) => row.type === 'Maker Night candle');
  assert.deepEqual(toSeats([{ ...ticket, adjustment: -1, sold: 2 }]), { event: '2026 Candle Sale', total: 5, left: 3 });
  assert.deepEqual(toSeats([{ ...ticket, sold: 9 }]), { event: '2026 Candle Sale', total: 6, left: 0 });
  assert.deepEqual(toSeats(ROWS.filter((row) => row !== ticket)), { event: '2026 Candle Sale', total: null, left: null });
  assert.deepEqual(toSeats([]), { event: null, total: null, left: null });
  assert.throws(() => toSeats([ticket, { ...ticket, id: 99 }]), /more than one Golden Ticket/);
});

test('a Grist failure on seats is a retryable 503, never cached', async () => {
  const { service, logs } = setup({ fail: { readStock: true } });
  const response = await service.handle(get('/api/seats'));
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(logs.some((entry) => entry.level === 'error'));
});

test('the self-check reads stock and writes nothing, open or closed', async () => {
  for (const [orders, window, products] of [[CLOSED, 'closed', 4], [PREORDER, 'preorder', 4], [AFTER, 'after', 5]]) {
    const { service, store } = setup({ orders });
    assert.deepEqual(await service.selfCheck(), { ok: true, event: '2026 Candle Sale', window, products });
    assert.deepEqual(writesIn(store), []);
  }
});

test('phones format the way the preorder import does', () => {
  assert.equal(formatMobile('612-555-0100'), '(612) 555-0100');
  assert.equal(formatMobile('1 612 555 0100'), '(612) 555-0100');
  assert.equal(formatMobile('+44 20 7946 0000'), '+44 20 7946 0000');
  assert.equal(formatMobile(''), '');
  assert.equal(formatMobile(undefined), '');
});

test('the Grist store passes values as arguments and tells the key from a failure', async () => {
  const seen = [];
  let denied = 0;
  let status = 200;
  const store = gristStore({
    apiKey: 'key',
    docId: 'doc',
    onDenied: () => denied++,
    fetch: async (url, init) => {
      seen.push({ url, init });
      return { ok: status < 400, status, json: async () => ({ records: [] }) };
    }
  });
  const sneaky = "x' or '1'='1";
  assert.equal(await store.findPerson(sneaky), null);
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body.args, [sneaky]);
  assert.ok(!body.sql.includes(sneaky));
  assert.equal(seen[0].url, 'https://docs.getgrist.com/api/docs/doc/sql');

  status = 401;
  await assert.rejects(store.readStock(), (error) => error.step === 'stock' && error.status === 401);
  assert.equal(denied, 1);
  status = 500;
  await assert.rejects(store.readStock());
  assert.equal(denied, 1);
});

test('a refused or missing Turnstile token is a 422 before any call to Grist, with the codes logged', async () => {
  const { service, store, logs } = setup();
  const response = await service.handle(post(order({ turnstile: 'bad' })));
  assert.equal(response.statusCode, 422);
  assert.deepEqual(parse(response), { error: 'turnstile' });
  assert.deepEqual(store.state.calls, []);
  assert.deepEqual(logs.at(-1).codes, ['invalid-input-response']);
});

test('the token is checked after the form is, so a typo costs no token', async () => {
  const { service, checks } = setup();
  await service.handle(post(order({ email: 'nope', turnstile: 'token' })));
  await service.handle(post(order({ website: 'spam', turnstile: 'token' })));
  assert.deepEqual(checks, []);
  await service.handle(post(order({ turnstile: 'token' })));
  assert.deepEqual(checks, [{ token: 'token' }]);
});

test('Turnstile unreachable is a retryable 503 and an error; the retry is checked again', async () => {
  let down = true;
  const { service, store, logs, checks } = setup({
    verify: async () => {
      if (down) throw Object.assign(new Error('timeout'), { step: 'turnstile' });
      return { ok: true, codes: [] };
    }
  });
  const response = await service.handle(post(order({ turnstile: 'token' })));
  assert.equal(response.statusCode, 503);
  assert.deepEqual(store.state.calls, []);
  assert.ok(logs.some((entry) => entry.level === 'error' && entry.outcome === 'turnstile-failed'));
  down = false;
  assert.equal((await service.handle(post(order({ turnstile: 'token' })))).statusCode, 200);
  assert.equal(checks.length, 2);
});

test('a retry of a proven order is not checked again: its token is spent', async () => {
  const { service, checks } = setup({ fail: { addLines: true } });
  assert.equal((await service.handle(post(order({ turnstile: 'one' })))).statusCode, 503);
  assert.equal(checks.length, 1);
  // Same request id, same spent token, as the page resends it.
  await service.handle(post(order({ turnstile: 'one' })));
  assert.equal(checks.length, 1);
});

test('a proven request id is forgotten after a while', async () => {
  const { service, checks, clock } = setup({ fail: { addLines: true } });
  await service.handle(post(order({ turnstile: 'one' })));
  clock.time += 16 * 60_000;
  await service.handle(post(order({ turnstile: 'two' })));
  assert.deepEqual(checks, [{ token: 'one' }, { token: 'two' }]);
});

test('a new order adds the buyer to the list once; a duplicate does not add them again', async () => {
  const { service, joins, logs } = setup();
  assert.equal((await service.handle(post(order()))).statusCode, 200);
  assert.deepEqual(joins, [{ email: 'testy@example.com', ip: '198.51.100.10' }]);
  assert.equal(logs.at(-1).list, 'added');
  assert.equal((await service.handle(post(order()))).statusCode, 200);
  assert.equal(joins.length, 1);
});

test('nobody is added when the order fails, is short, or is refused', async () => {
  for (const run of [
    { setup: setup({ fail: { addLines: true } }), body: order() },
    { setup: setup(), body: order({ items: [{ product: 13, quantity: 2 }] }) },
    { setup: setup(), body: order({ turnstile: 'bad' }) }
  ]) {
    await run.setup.service.handle(post(run.body));
    assert.deepEqual(run.setup.joins, []);
  }
});

test('a list that fails or refuses never costs the order', async () => {
  const broken = setup({
    subscribe: async () => {
      throw Object.assign(new Error('down'), { step: 'buttondown', status: 500 });
    }
  });
  const response = await broken.service.handle(post(order()));
  assert.equal(response.statusCode, 200);
  assert.equal(parse(response).ok, true);
  assert.ok(broken.logs.some((entry) => entry.level === 'error' && entry.outcome === 'list-failed'));
  assert.equal(broken.logs.at(-1).list, 'failed');

  const refused = setup({ subscribe: async () => ({ outcome: 'refused', code: 'ip_address_spammy' }) });
  assert.equal((await refused.service.handle(post(order()))).statusCode, 200);
  assert.ok(refused.logs.some((entry) => entry.level === 'warn' && entry.code === 'ip_address_spammy'));
  assert.ok(!refused.logs.some((entry) => entry.level === 'error'));
});

test('without a verifier no order gets in', async () => {
  const service = createService({ store: fakeStore(), orders: AFTER, now: () => 1_800_000_000_000, floorMs: 0, log: () => {} });
  assert.equal((await service.handle(post(order()))).statusCode, 503);
});

const answer = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('siteverify: the token goes with the secret; host, action and spent tokens are checked', async () => {
  const seen = [];
  let reply = answer(200, { success: true, hostname: 'things4good.xyz', action: 'order' });
  let denied = 0;
  const verify = turnstileVerifier({
    secret: 'shh',
    onDenied: () => denied++,
    fetch: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return reply;
    }
  });
  assert.deepEqual(await verify({ token: 'tok' }), { ok: true, codes: [] });
  assert.equal(seen[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.deepEqual(seen[0].body, { secret: 'shh', response: 'tok' });

  for (const [token, codes] of [[undefined, ['missing-input-response']], ['', ['missing-input-response']], ['x'.repeat(2049), ['missing-input-response']]])
    assert.deepEqual(await verify({ token }), { ok: false, codes });
  assert.equal(seen.length, 1); // None of those reached Cloudflare.

  reply = answer(200, { success: true, hostname: 'evil.example', action: 'order' });
  assert.deepEqual(await verify({ token: 'tok' }), { ok: false, codes: ['wrong-hostname'] });
  reply = answer(200, { success: true, hostname: 'www.things4good.xyz', action: 'login' });
  assert.deepEqual(await verify({ token: 'tok' }), { ok: false, codes: ['wrong-action'] });
  reply = answer(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
  assert.deepEqual(await verify({ token: 'tok' }), { ok: false, codes: ['timeout-or-duplicate'] });

  reply = answer(200, { success: false, 'error-codes': ['invalid-input-secret'] });
  await assert.rejects(verify({ token: 'tok' }), (error) => error.step === 'turnstile' && error.codes.includes('invalid-input-secret'));
  assert.equal(denied, 1);
  reply = answer(502, {});
  await assert.rejects(verify({ token: 'tok' }), (error) => error.step === 'turnstile' && error.status === 502);
  const offline = turnstileVerifier({ secret: 'shh', fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(offline({ token: 'tok' }), (error) => error.step === 'turnstile');
});

test('Buttondown: added without a confirmation email, never resubscribed, refusals told from failures', async () => {
  const seen = [];
  let reply = answer(201, { id: 'sub' });
  let denied = 0;
  const subscribe = buttondownSubscriber({
    apiKey: 'key',
    onDenied: () => denied++,
    fetch: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return reply;
    }
  });
  assert.deepEqual(await subscribe({ email: 'a@example.com', ip: '198.51.100.10' }), { outcome: 'added' });
  assert.equal(seen[0].url, 'https://api.buttondown.com/v1/subscribers');
  assert.equal(seen[0].headers.Authorization, 'Token key');
  assert.ok(!Object.keys(seen[0].headers).some((name) => /collision|bypass/i.test(name)));
  assert.deepEqual(seen[0].body, { email_address: 'a@example.com', type: 'regular', notes: 'Added by the order form', ip_address: '198.51.100.10' });

  await subscribe({ email: 'a@example.com', ip: 'unknown' });
  assert.ok(!('ip_address' in seen[1].body));

  for (const code of ['email_already_exists', 'subscriber_already_exists', 'subscriber_suppressed', 'subscriber_blocked']) {
    reply = answer(400, { code, detail: 'x' });
    assert.deepEqual(await subscribe({ email: 'a@example.com', ip: 'unknown' }), { outcome: 'already' });
  }
  reply = answer(400, { code: 'email_invalid', detail: 'x' });
  assert.deepEqual(await subscribe({ email: 'a@example.com', ip: 'unknown' }), { outcome: 'refused', code: 'email_invalid' });
  reply = answer(429, {});
  assert.deepEqual(await subscribe({ email: 'a@example.com', ip: 'unknown' }), { outcome: 'refused', code: 'status-429' });

  reply = answer(401, { detail: 'bad key' });
  await assert.rejects(subscribe({ email: 'a@example.com', ip: 'unknown' }), (error) => error.step === 'buttondown' && error.status === 401);
  assert.equal(denied, 1);
  reply = answer(500, {});
  await assert.rejects(subscribe({ email: 'a@example.com', ip: 'unknown' }), (error) => error.status === 500);
});
