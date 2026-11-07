// Balance read from the real table body:
//   "IDR 278 Wallet Weekly Prize Monthly Prize $50,000.00 $100,000.00 Dice ..."
// The wallet is the first IDR figure; the dollar amounts are prize pools, and the bet
// field prints "IDR 0". Both naive strategies were wrong on the live page — "first
// number" gave BAL 0, "biggest number" gave BAL 100,000.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBalance } from '../src/perceive.js';

const REAL_BODY = 'IDR 278 Wallet Weekly Prize Monthly Prize $50,000.00 $100,000.00 Dice Fair Turbo';

test('the wallet figure wins over the prize pool', () => {
  assert.equal(parseBalance(null, REAL_BODY), 278);
});

test('a zero wallet node does not beat a funded body', () => {
  assert.equal(parseBalance('IDR 0', 'Bet Amount IDR 0\nIDR 279'), 279);
});

test('node text and IDR thousands parse', () => {
  assert.equal(parseBalance('IDR 279', ''), 279);
  assert.equal(parseBalance(null, 'Wallet\nIDR 1.234,56'), 1234.56);
});

test('an explicitly empty wallet reads zero, and a page with no figure reads null', () => {
  assert.equal(parseBalance('IDR 0', ''), 0);
  assert.equal(parseBalance(null, 'IDR 0 Bet Amount IDR 0'), 0);
  assert.equal(parseBalance(null, 'Make it count. Dice.'), null);
});
