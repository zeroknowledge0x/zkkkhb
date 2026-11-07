// Chat replies: real viewers are spoken, promo is not, captions clear after playback.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop, TALK_REPLY } from '../src/agent.js';
import { AudioBus } from '../src/audio.js';
import { Brain } from '../src/brain.js';
import { CAPTION_FADE_MS, CAPTION_HOLD_MS, captionStyle } from '../src/caption.js';
import {
  cannedAck,
  composeChatReply,
  createChatIntake,
  createKickDedupe,
  formatChatSkip,
  ingestAfterScroll,
  ingestKickRows,
  isSelfName,
  normHandle,
  offerReply,
  parseKickRow,
  parseTuneRequest,
  planChat,
  safeTuneValue,
  visibleChatMessages,
} from '../src/chat-reply.js';
import { parseGameRequest, PlayQueue } from '../src/play-queue.js';

const LIVE = [
  ['LiveHubi', 'other game plis'],
  ['LiveHubi', 'hi'],
  ['LiveHubi', 'change game'],
  ['LiveHubi', 'limbo'],
  ['LiveHubi', 'target 100'],
  ['LiveHubi', 'multi change to 100'],
  ['LiveHubi', 'change limbo'],
  ['LiveHubi', 'Hi'],
  ['eeyessskovf103', "Wsup boss, how's your day? Just checking if the legend is still legendary"],
  ['eeyessskovf103', '@hubiezk Make your stream fire with "Bot Liva com"'],
  ['eeyessskovf103', 'With our AI service, your chat stays online 24/7. To stop receiving messages, simply type !noads'],
  ['eeyessskovf103', "Keep shining, you're doing great!"],
  ['LiveHubi', 'Hi'],
  ['Jamesdigital1', "Yo! What's good? Enjoying your stream!"],
];

function absorb(messages) {
  const intake = createChatIntake({ selfNames: ['hubiezk'] });
  const shown = [];
  const plans = [];
  const skips = [];
  for (const [name, text] of messages) {
    const decision = intake.screen({ name, text });
    if (decision.action === 'skip') {
      skips.push(decision);
      if (decision.purge) {
        for (let i = shown.length - 1; i >= 0; i--) {
          if (normHandle(shown[i].name) === normHandle(name)) shown.splice(i, 1);
        }
      }
      continue;
    }
    shown.push({ name, text });
    const tune = parseTuneRequest(text);
    const request = tune ? null : parseGameRequest(text);
    plans.push({
      name,
      text,
      tune,
      request,
      plan: planChat({ text, greeted: false, queueAnnounced: !!request }),
    });
  }
  return { intake, shown, plans, skips };
}

test('LiveHubi is a viewer; hubiezk is the owner account', () => {
  assert.equal(isSelfName('LiveHubi'), false);
  assert.equal(isSelfName('LiveHubi', ['hubie', 'hubiezk']), false);
  assert.equal(isSelfName('hubiezk'), true);
  assert.equal(isSelfName('Hubie'), true);
  assert.equal(isSelfName('HUBIE ZK'), true);
});

test('the live Kick window keeps real viewers, drops the promo bot, and plans a reply', () => {
  const { shown, plans, skips, intake } = absorb(LIVE);
  assert.ok(shown.some((m) => m.name === 'LiveHubi' && m.text === 'limbo'));
  assert.ok(shown.some((m) => m.name === 'Jamesdigital1'));
  assert.equal(shown.some((m) => m.name === 'eeyessskovf103'), false);
  assert.ok(skips.some((s) => s.reason === 'promo' && s.name === 'eeyessskovf103'));
  assert.match(formatChatSkip(skips.find((s) => s.reason === 'promo')), /^chat_skip reason=promo n=\d+ name=eeyessskovf103$/);
  assert.match(intake.summary(), /promo=/);

  const limbo = plans.find((p) => p.text === 'limbo');
  assert.equal(limbo.request, 'Limbo');
  assert.equal(limbo.plan.action, 'queue');
  const other = plans.find((p) => p.text === 'other game plis');
  assert.equal(other.request, '__random__');
  assert.equal(other.plan.action, 'queue');
  const change = plans.find((p) => p.text === 'change game');
  assert.equal(change.request, '__random__');
  const changeLimbo = plans.find((p) => p.text === 'change limbo');
  assert.equal(changeLimbo.request, 'Limbo');

  const target = plans.find((p) => p.text === 'target 100');
  assert.equal(target.tune.kind, 'target');
  assert.equal(target.tune.value, 100);
  assert.equal(target.plan.action, 'reply');
  assert.equal(safeTuneValue('target', 100).ok, false);
  const multi = plans.find((p) => p.text === 'multi change to 100');
  assert.equal(multi.tune.kind, 'multiplier');
  assert.equal(safeTuneValue(multi.tune.kind, multi.tune.value).reason, 'out_of_band');
  assert.equal(safeTuneValue('target', 2).ok, true);
  assert.equal(safeTuneValue('chance', 50).ok, true);

  const james = plans.find((p) => p.name === 'Jamesdigital1');
  assert.equal(james.plan.action, 'reply');
  assert.equal(planChat({ text: 'hi', greeted: true }).action, 'greet');
  assert.equal(planChat({ text: 'Hi', greeted: false }).action, 'reply');
  assert.equal(planChat({ text: "Yo! What's good? Enjoying your stream!", greeted: true }).action, 'reply');

  const pending = [];
  for (const line of plans) assert.equal(offerReply(pending, line).ok, true);
  assert.equal(pending.length, plans.length);
  assert.ok(pending.length > 3);
});

test('a Kick row with no message span still yields the viewer line', () => {
  const row = parseKickRow({
    name: 'LiveHubi',
    text: 'LiveHubi',
    innerText: 'LiveHubi\nother game plis',
  });
  assert.deepEqual(row, { name: 'LiveHubi', text: 'other game plis' });
  const stamped = parseKickRow({
    name: '',
    text: '',
    innerText: '4:09 PM\nJamesdigital1\nYo! What\'s good? Enjoying your stream!',
  });
  assert.equal(stamped.name, 'Jamesdigital1');
  assert.match(stamped.text, /Enjoying your stream/);
});

test('pinning a stuck scroller delivers the rows that were below the fold', () => {
  const state = createKickDedupe({ dedupeMs: 1000 });
  const stuck = [{ name: 'eeyessskovf103', text: 'Bot Liva com promo' }];
  const latest = [
    ...stuck,
    { name: 'LiveHubi', text: 'limbo' },
    { name: 'Jamesdigital1', text: 'Yo! What\'s good? Enjoying your stream!' },
  ];
  const opened = ingestAfterScroll(state, stuck, latest, 1000);
  assert.deepEqual(opened.fresh.map((r) => r.name), ['LiveHubi', 'Jamesdigital1']);
  const again = ingestKickRows(state, latest, 1500);
  assert.equal(again.fresh.length, 0);
  const scrolled = ingestKickRows(state, stuck, 1800);
  assert.equal(scrolled.fresh.length, 0);
  const repeated = ingestKickRows(state, latest, 1900);
  assert.equal(repeated.fresh.length, 0);
  assert.equal(repeated.skipped[0].reason, 'dedupe');
  assert.match(formatChatSkip(repeated.skipped[0]), /^chat_skip reason=dedupe /);
  ingestKickRows(state, stuck, 2500);
  const later = ingestKickRows(state, latest, 4000);
  assert.deepEqual(later.fresh.map((r) => r.name), ['LiveHubi', 'Jamesdigital1']);
});

test('chat replies stay queued past the old cap and speak in order when the mouth is free', async () => {
  let speaking = true;
  let release = () => {};
  const spoken = [];
  const agent = new AgentLoop({
    brain: { offline: true, async say() { return { text: '', fallback: true }; } },
    tools: {
      reportAll() {
        return {
          stream: { speaking },
          game: { ready: false, hasFrame: false, url: '', title: '', clickables: [], bodySnippet: '' },
        };
      },
    },
    speak: (text) => new Promise((resolve) => {
      spoken.push(text);
      release = resolve;
    }),
    speakCooldownMs: 18000,
    idleSpeakMs: 10 * 60 * 1000,
  });
  for (let i = 0; i < 13; i++) {
    assert.equal(agent.enqueue(`Answer ${i} for a real viewer.`, 'reply', { chatId: `c${i}` }), true);
  }
  assert.equal(agent.talkQueue.length, 13);
  assert.equal(agent.talkQueue[0].priority, TALK_REPLY);
  assert.deepEqual(agent.talkQueue.map((q) => q.chatId), Array.from({ length: 13 }, (_, i) => `c${i}`));
  for (const q of agent.talkQueue) q.at = Date.now() - 15000;
  agent.lastSpokeAt = Date.now();
  assert.equal(agent.enqueue('Heard you, sam.', 'reply', { chatId: 'a' }), true);
  assert.equal(agent.enqueue('Heard you, sam.', 'reply', { chatId: 'b' }), true);

  agent.talkQueue.length = 2;
  agent.talkQueue[0].say = 'First real answer.';
  agent.talkQueue[1].say = 'Second real answer.';
  agent.start();
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(spoken, []);
    assert.equal(agent.talkQueue.length, 2);
    speaking = false;
    await waitFor(() => spoken.length >= 1);
    assert.deepEqual(spoken, ['First real answer.']);
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(spoken, ['First real answer.']);
    release();
    await waitFor(() => spoken.length >= 2);
    assert.deepEqual(spoken, ['First real answer.', 'Second real answer.']);
  } finally {
    agent.stop();
  }
});

test('a stale win is still dropped and a brain timeout becomes a fast canned ack', async () => {
  const spoken = [];
  let speaking = false;
  const agent = new AgentLoop({
    brain: { offline: true, async say() { return { text: '', fallback: true }; } },
    tools: {
      reportAll() {
        return {
          stream: { speaking },
          game: { ready: false, hasFrame: false, url: '', clickables: [] },
        };
      },
    },
    speak: async (text) => { spoken.push(text); },
    speakCooldownMs: 0,
  });
  agent.enqueue('Eh win.', 'react:win', { eventAt: Date.now() - 5000 });
  agent.start();
  await waitFor(() => agent.talkQueue.length === 0);
  agent.stop();
  assert.deepEqual(spoken, []);

  let jev = 0;
  const slow = new Brain(
    { llmKey: 'k', llmUrl: 'http://llm.test/v1/chat/completions', llmModel: 'm' },
    {
      fetchImpl: (_url, opts) => new Promise((_, reject) => {
        const fail = () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          reject(err);
        };
        if (opts?.signal?.aborted) fail();
        else opts?.signal?.addEventListener('abort', fail, { once: true });
      }),
    },
  );
  const t0 = Date.now();
  const keep = setInterval(() => {}, 50);
  let timed;
  try {
    timed = await composeChatReply(
      { name: 'Jamesdigital1', text: "Yo! What's good? Enjoying your stream!" },
      { brain: slow, jevReply: async () => { jev += 1; return { text: 'kb line' }; }, timeoutMs: 80 },
    );
  } finally {
    clearInterval(keep);
  }
  assert.ok(Date.now() - t0 < 1000, `timeout took ${Date.now() - t0}ms`);
  assert.equal(timed.source, 'canned');
  assert.equal(timed.reason, 'timeout');
  assert.equal(jev, 0);
  assert.match(timed.text, /Jamesdigital1/);

  const fast = new Brain(
    { llmKey: 'k', llmUrl: 'http://llm.test/v1/chat/completions', llmModel: 'm' },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'Yo James, the table is free. {"emotion":"chill","gesture":"lookChat"}' } }] };
        },
      }),
    },
  );
  const brainLine = await composeChatReply(
    { name: 'Jamesdigital1', text: 'Yo! What\'s good?' },
    { brain: fast, timeoutMs: 1000 },
  );
  assert.equal(brainLine.source, 'brain');
  assert.match(brainLine.text, /James/);
  assert.doesNotMatch(brainLine.text, /\{/);
  assert.match(cannedAck('LiveHubi'), /LiveHubi/);
});

test('caption holds 1.5s after AudioBus playback end, then fades', () => {
  const line = 'Limbo is next. Still free.';
  const playing = captionStyle(line, { playbackEndedAt: null, now: 5000 });
  assert.equal(playing.alpha, 1);
  assert.equal(playing.text, line);

  const endedAt = 10_000;
  const held = captionStyle(line, { playbackEndedAt: endedAt, now: endedAt + CAPTION_HOLD_MS - 1 });
  assert.equal(held.alpha, 1);
  const fading = captionStyle(line, { playbackEndedAt: endedAt, now: endedAt + CAPTION_HOLD_MS + CAPTION_FADE_MS / 2 });
  assert.ok(fading.alpha > 0 && fading.alpha < 1);
  assert.equal(fading.text, line);
  const gone = captionStyle(line, { playbackEndedAt: endedAt, now: endedAt + CAPTION_HOLD_MS + CAPTION_FADE_MS });
  assert.equal(gone.alpha, 0);
  assert.equal(gone.text, '');

  const bus = new AudioBus(1000);
  const ends = [];
  bus.onPlaybackEnd((token) => ends.push(token));
  bus.armPlayback(7);
  const pcm = Buffer.alloc(200);
  bus.push(pcm);
  bus.take(50);
  assert.deepEqual(ends, []);
  bus.take(50);
  assert.deepEqual(ends, [7]);
  bus.take(50);
  assert.deepEqual(ends, [7]);
});

test('overlay chat keeps the newest real line when older promo lines are long', () => {
  const chat = [
    { name: 'LiveHubi', text: 'limbo' },
    { name: 'eeyessskovf103', text: 'Make your stream fire with Bot Liva com '.repeat(12) },
    { name: 'eeyessskovf103', text: 'With our AI service your chat stays online 24/7 '.repeat(8) },
    { name: 'Jamesdigital1', text: "Yo! What's good? Enjoying your stream!" },
  ];
  const visible = visibleChatMessages(chat);
  assert.equal(visible.at(-1).name, 'Jamesdigital1');
  const real = visibleChatMessages(chat.filter((m) => m.name !== 'eeyessskovf103'));
  assert.deepEqual(real.map((m) => m.text), ['limbo', "Yo! What's good? Enjoying your stream!"]);
});

test('a viewer can replace their queued game and the stake helper is untouched', () => {
  const queue = new PlayQueue();
  queue.enqueue({ name: 'LiveHubi', game: 'Dice', from: 'chat' });
  const next = queue.enqueue({ name: 'LiveHubi', game: 'Limbo', from: 'chat' });
  assert.equal(next.game, 'Limbo');
  assert.equal(queue.peek().game, 'Limbo');
  assert.equal(queue.length, 1);
});

function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, 30);
    };
    tick();
  });
}
