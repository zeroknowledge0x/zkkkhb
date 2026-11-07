import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKickApiDedupe,
  ingestKickApiMessages,
  parseKickApiMessage,
  visibleChatMessages,
} from '../src/chat-reply.js';

const sample = [
  {
    id: 'a',
    content: 'Hi',
    created_at: '2026-11-06T20:46:11Z',
    sender: { username: 'LiveHubi' },
  },
  {
    id: 'b',
    content: 'Keno',
    created_at: '2026-11-06T20:47:12Z',
    sender: { username: 'LiveHubi', slug: 'livehubi' },
  },
];

test('parseKickApiMessage reads Kick public message shape', () => {
  const row = parseKickApiMessage(sample[1]);
  assert.equal(row.id, 'b');
  assert.equal(row.name, 'LiveHubi');
  assert.equal(row.text, 'Keno');
});

test('ingestKickApiMessages primes backlog then emits only new ids', () => {
  const state = createKickApiDedupe();
  const first = ingestKickApiMessages(state, sample, 1);
  assert.equal(first.primed, true);
  assert.equal(first.fresh.length, 0);
  assert.equal(state.seen.size, 2);

  const second = ingestKickApiMessages(state, sample, 2);
  assert.equal(second.fresh.length, 0);

  const third = ingestKickApiMessages(state, [
    ...sample,
    {
      id: 'c',
      content: 'limbo',
      created_at: '2026-11-06T21:00:00Z',
      sender: { username: 'LiveHubi' },
    },
  ], 3);
  assert.equal(third.fresh.length, 1);
  assert.equal(third.fresh[0].text, 'limbo');
  assert.equal(third.fresh[0].id, 'c');
});

test('visibleChatMessages compact panel keeps newest short lines', () => {
  const chat = [
    { name: 'Old', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa long' },
    { name: 'A', text: 'one' },
    { name: 'B', text: 'two' },
    { name: 'C', text: 'three' },
    { name: 'D', text: 'four' },
    { name: 'E', text: 'five' },
  ];
  const shown = visibleChatMessages(chat, { maxPx: 118, linePx: 14, pad: 8, maxChars: 26 });
  assert.ok(shown.length <= 5);
  assert.equal(shown[shown.length - 1].name, 'E');
});
