// The Maker Night seat sync: Grist's Left decides, the page's total caps it, and nothing changes the file
// unless the count did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSeats } from '../scripts/maker-night-seats.mjs';

const FILE = { _note: 'kept', total: 6, sold: 0 };

test('a sale in Grist moves sold, and the note stays', () => {
  assert.deepEqual(nextSeats(FILE, { event: '2026 Candle Sale', total: 6, left: 4 }), { _note: 'kept', total: 6, sold: 2 });
  assert.deepEqual(nextSeats({ ...FILE, sold: 2 }, { total: 6, left: 6 }), { _note: 'kept', total: 6, sold: 0 });
});

test('the same count, or no Golden Ticket in Grist, changes nothing', () => {
  assert.equal(nextSeats(FILE, { total: 6, left: 6 }), null);
  assert.equal(nextSeats(FILE, { event: null, total: null, left: null }), null);
});

test('Grist never shows more seats than the page has, and fewer made means fewer left', () => {
  assert.equal(nextSeats(FILE, { total: 8, left: 8 }), null);
  assert.deepEqual(nextSeats(FILE, { total: 5, left: 5 }), { _note: 'kept', total: 6, sold: 1 });
  assert.deepEqual(nextSeats(FILE, { total: 6, left: 0 }), { _note: 'kept', total: 6, sold: 6 });
});

test('an answer that is not a count is an error, not a sold-out page', () => {
  for (const answer of [{ total: 6 }, { total: 6, left: -1 }, { total: '6', left: 6 }, { total: 6, left: 2.5 }])
    assert.throws(() => nextSeats(FILE, answer), /unexpected seats answer/);
});
