// Phase C: screen-state parser, vision fallback limits, and the bet=0 guard.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AgentLoop } from '../src/agent.js';
import { demoStakeString, DEMO_STAKE, guardBetAmount, isStakeField } from '../src/bet-guard.js';
import { Brain } from '../src/brain.js';
import { cfg } from '../src/config.js';
import { PlayQueue } from '../src/play-queue.js';
import {
  chooseRotateGame,
  emptyState,
  GamePerception,
  groundReaction,
  parseDomState,
  parseVisionSummary,
} from '../src/perceive.js';

const DICE = 'https://www.housebets.com/games/housegames-dice';
const KENO = 'https://www.housebets.com/games/housegames-keno';

function diceDom(extra = {}) {
  return {
    url: DICE,
    title: 'Dice',
    body: 'Balance: $0.00 multiplier 1.98',
    clickables: [{ text: 'Bet', tag: 'button' }, { text: 'Roll', tag: 'button' }],
    outcome: { result: 88.75, won: true, source: 'marker' },
    ...extra,
  };
}

test('parser reads dice result, balance, multiplier, and round', () => {
  const state = parseDomState(diceDom());
  assert.equal(state.ok, true);
  assert.equal(state.source, 'dom');
  assert.equal(state.game, 'Dice');
  assert.equal(state.balance, 0);
  assert.equal(state.multiplier, 1.98);
  assert.deepEqual(state.lastResult, { value: 88.75, won: true });
  assert.equal(state.round, 'settled');
  assert.equal(state.sufficient, true);
});

test('parser keeps a labeled balance and ignores a bare bet amount and promo copy', () => {
  const state = parseDomState({
    url: 'https://www.housebets.com/casino',
    title: 'Housebets Casino',
    body: 'Bet amount 5.00\nBalance: $1,234.50\nwin up to 1000x',
    balanceText: '$1,234.50',
    clickables: [
      { text: 'Meet the house with DICE and more' },
      { text: 'Play Dice in the mini' },
      { text: 'Dice' },
      { text: 'Crash' },
      { text: 'Dragon Tower' },
      { text: 'Max Win' },
    ],
  });
  assert.equal(state.game, null);
  assert.equal(state.balance, 1234.5);
  assert.equal(state.multiplier, null);
  assert.deepEqual(state.lobby, ['Dice', 'Limbo', 'Tower', 'Max Win']);
  assert.equal(state.sufficient, true);
});

test('keno payhit becomes the multiplier and a comma roll survives', () => {
  const keno = parseDomState({
    url: KENO,
    title: 'Keno',
    body: '',
    clickables: [{ text: 'Bet' }],
    outcome: { result: 3, won: true, hits: '3 of 10', source: 'keno-payhit' },
  });
  assert.equal(keno.game, 'Keno');
  assert.equal(keno.multiplier, 3);
  assert.equal(keno.lastResult.value, 3);
  assert.equal(keno.lastResult.won, true);

  const rolled = parseDomState({
    url: DICE,
    title: 'Dice',
    body: 'rolled 88,75 you lose',
    clickables: [],
  });
  assert.equal(rolled.lastResult.value, 88.75);
  assert.equal(rolled.lastResult.won, false);
});

test('a game name alone is not enough, and garbage does not throw', () => {
  const thin = parseDomState({ url: DICE, title: 'Dice', body: '', clickables: [] });
  assert.equal(thin.game, 'Dice');
  assert.equal(thin.sufficient, false);

  for (const raw of [null, undefined, 0, '', [], { clickables: null }, { outcome: { result: 'nope' } }]) {
    const state = parseDomState(raw);
    assert.equal(typeof state.ok, 'boolean');
    assert.ok(Array.isArray(state.lobby));
  }
  assert.equal(emptyState().source, 'none');
});

test('vision summary fills the same shape and rejects junk', () => {
  const state = parseVisionSummary('```json\n{"game":"Plinko","balance":0,"lastResult":12,"won":false,"multiplier":2.5,"round":"settled","lobby":["Mines","Dice"]}\n```');
  assert.equal(state.game, 'Plinko');
  assert.equal(state.balance, 0);
  assert.equal(state.multiplier, 2.5);
  assert.equal(state.lastResult.value, 12);
  assert.equal(state.lastResult.won, false);
  assert.equal(state.round, 'settled');
  assert.deepEqual(state.lobby, ['Mines', 'Dice']);
  assert.equal(state.source, 'vision');
  assert.equal(parseVisionSummary('no idea'), null);
  assert.equal(parseVisionSummary('{"game":null,"lobby":[]}'), null);
});

test('reactions quote measured numbers and stay quiet without them', () => {
  const dice = parseDomState(diceDom());
  const win = groundReaction({ tag: 'win', state: dice });
  assert.match(win, /88\.75/);
  assert.doesNotMatch(win, /1\.98/);
  assert.ok(win.split(/\s+/).length <= 18);

  const keno = parseDomState({
    url: KENO,
    title: 'Keno',
    clickables: [{ text: 'Bet' }],
    outcome: { result: 3, won: true, source: 'keno-payhit' },
  });
  assert.match(groundReaction({ tag: 'win', state: keno }), /3 times on Keno/);

  const streak = { ...dice, lastResult: { value: 40, won: false }, streak: { kind: 'lose', count: 2 } };
  assert.match(groundReaction({ tag: 'lose', state: streak }), /2 misses/);
  assert.equal(groundReaction({ tag: 'win', state: null }), null);
  assert.equal(groundReaction({ tag: 'win', state: emptyState() }), null);
});

test('rotate pick stays inside the observed lobby and off the current table', () => {
  const brain = chooseRotateGame({
    observed: ['Dice', 'Mines', 'Plinko'],
    brainPick: 'Plinko',
    current: 'dice',
  });
  assert.deepEqual(brain, { game: 'Plinko', source: 'brain' });

  const invented = chooseRotateGame({
    observed: ['Dice', 'Mines'],
    brainPick: 'Slots',
    current: 'Dice',
    random: () => 0,
  });
  assert.deepEqual(invented, { game: 'Mines', source: 'observed' });

  const scripted = chooseRotateGame({
    observed: [],
    brainPick: 'Plinko',
    scripted: ['dice', 'mine', 'limbo'],
    current: 'Dice',
    random: () => 0,
  });
  assert.equal(scripted.source, 'scripted');
  assert.notEqual(scripted.game, 'Dice');
});

test('perception polls the DOM, rate-limits vision, and never throws', async () => {
  let now = 100000;
  let reads = 0;
  const shots = [];
  const dom = new GamePerception({
    intervalMs: 1000,
    visionMs: 20000,
    now: () => now,
    readDom: async () => {
      reads += 1;
      return diceDom();
    },
    summarize: async () => { shots.push('dom'); return '{"game":"Mines"}'; },
  });
  const first = await dom.sample();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(first.game, 'Dice');
  assert.equal(shots.length, 0);
  now += 500;
  await dom.sample();
  assert.equal(reads, 1);

  const thin = [];
  const vision = new GamePerception({
    intervalMs: 1000,
    visionMs: 20000,
    now: () => now,
    readDom: async () => ({ url: 'https://www.housebets.com/casino', title: '', body: '', clickables: [] }),
    captureFrame: async () => Buffer.from([1, 2, 3, 4]),
    summarize: async () => {
      thin.push(now);
      return 'nope';
    },
  });
  await vision.sample();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(thin.length, 1);
  now += 5000;
  await vision.sample();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(thin.length, 1);
  now += 20000;
  await vision.sample();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(thin.length, 2);

  let calls = 0;
  const off = new GamePerception({
    enabled: false,
    readDom: async () => { calls += 1; return diceDom(); },
  });
  const quiet = await off.sample();
  assert.equal(quiet.ok, false);
  assert.equal(calls, 0);

  const broken = new GamePerception({
    now: () => now,
    readDom: async () => { throw new Error('page gone'); },
    summarize: async () => { throw new Error('llm down'); },
  });
  const kept = await broken.sample();
  assert.equal(kept.ok, false);
  await new Promise((r) => setTimeout(r, 30));
});

test('streak counts settled results across samples', async () => {
  let now = 1000;
  let outcome = { result: 10, won: false, source: 'marker' };
  const perception = new GamePerception({
    intervalMs: 1000,
    now: () => now,
    readDom: async () => diceDom({ outcome, body: 'Balance 0' }),
    captureFrame: async () => null,
  });
  await perception.sample();
  assert.deepEqual(perception.state.streak, { kind: 'lose', count: 1 });
  outcome = { result: 12, won: false, source: 'marker' };
  now += 1000;
  await perception.sample();
  assert.deepEqual(perception.state.streak, { kind: 'lose', count: 2 });
  assert.match(groundReaction({ tag: 'lose', state: perception.state }), /2 misses in a row on Dice/);
});

test('bet guard is always 0 and ensureBetZero types only that zero', () => {
  assert.equal(DEMO_STAKE, 0);
  assert.deepEqual(guardBetAmount(0), { ok: true, stake: 0, rejected: null });
  assert.deepEqual(guardBetAmount('0'), { ok: true, stake: 0, rejected: null });
  assert.equal(guardBetAmount('0.00').ok, true);
  assert.equal(guardBetAmount('0.00').stake, 0);
  for (const bad of [1, 0.01, '5', '1.50', -1, null, undefined, '', '1,000', 'nope']) {
    const guarded = guardBetAmount(bad);
    assert.equal(guarded.ok, false, `expected reject for ${bad}`);
    assert.equal(guarded.stake, 0);
  }
  assert.equal(demoStakeString(), '0');
  assert.equal(isStakeField('bet amount'), true);
  assert.equal(isStakeField('multiplier'), false);

  const src = fs.readFileSync(new URL('../src/game.js', import.meta.url), 'utf8');
  const bet = src.slice(src.indexOf('async ensureBetZero'), src.indexOf('async nudgePayoutOrTarget'));
  assert.match(bet, /demoStakeString\(/);
  assert.match(bet, /String\(zero\) !== '0'/);
  assert.match(bet, /setNative\(el, zero\)/);
  assert.doesNotMatch(bet, /setNative\(el,\s*['"][1-9]/);
  const nudge = src.slice(src.indexOf('async nudgePayoutOrTarget'), src.indexOf('async #launch'));
  assert.match(nudge, /if \(BET\.test\(labels\)\) continue/);
  assert.doesNotMatch(nudge, /setNative\(el,\s*['"][1-9]/);
});

test('perception flags default on and vision cannot be faster than 20s', () => {
  const prev = {
    GAME_PERCEPTION: process.env.GAME_PERCEPTION,
    GAME_PERCEPTION_MS: process.env.GAME_PERCEPTION_MS,
    GAME_PERCEPTION_VISION_MS: process.env.GAME_PERCEPTION_VISION_MS,
  };
  process.env.GAME_PERCEPTION = '0';
  process.env.GAME_PERCEPTION_MS = '50';
  process.env.GAME_PERCEPTION_VISION_MS = '1000';
  try {
    const off = cfg();
    assert.equal(off.gamePerception, false);
    assert.equal(off.gamePerceptionMs, 1000);
    assert.equal(off.gamePerceptionVisionMs, 20000);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('idle prompt is told the measured screen and pickGame cannot leave the list', async () => {
  const state = parseDomState(diceDom());
  state.streak = { kind: 'win', count: 1 };
  const { brain, calls } = mockBrain('Still on Dice. {"emotion":"chill","gesture":"none"}');
  const shaped = await brain.say('idle', { segment: 'play', game: 'Dice', state });
  assert.equal(shaped.fallback, false);
  assert.match(calls[0].messages[0].content, /SCREEN/);
  assert.match(calls[0].messages.at(-1).content, /88\.75/);
  assert.match(calls[0].messages.at(-1).content, /1\.98/);

  const picker = mockBrain('{"game":"Slots"}');
  assert.equal(await picker.brain.pickGame({ lobby: ['Dice', 'Plinko'], current: 'Dice', state }), null);
  const ok = mockBrain('{"game":"Plinko"}');
  assert.equal(await ok.brain.pickGame({ lobby: ['Dice', 'Plinko'], current: 'Dice' }), 'Plinko');
  assert.match(ok.calls[0].messages[1].content, /Plinko/);
  assert.equal(await new Brain({ llmKey: '' }, {}).pickGame({ lobby: ['Dice'] }), null);
});

function mockBrain(content) {
  const calls = [];
  const brain = new Brain(
    { llmKey: 'test-key', llmUrl: 'http://127.0.0.1:9/v1/chat', llmModel: 'test' },
    {
      fetchImpl: async (_url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push(body);
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        };
      },
    },
  );
  return { brain, calls };
}

function diceTools() {
  return {
    reportAll() {
      return {
        game: {
          ready: true,
          hasFrame: true,
          url: DICE,
          title: 'Dice',
          clickables: [{ text: 'Bet', tag: 'button' }],
          bodySnippet: '',
        },
        stream: { speaking: false },
      };
    },
  };
}

async function waitFor(fn, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
}

test('chat queue beats a perceived lobby pick', async () => {
  const queue = new PlayQueue();
  queue.enqueue({ name: 'sam', game: 'Mines' });
  const nav = [];
  let picks = 0;
  const agent = new AgentLoop({
    brain: {
      offline: false,
      async pickGame() { picks += 1; return 'Plinko'; },
      async say() { return { text: '', fallback: true }; },
    },
    tools: diceTools(),
    game: { async navigate(url) { nav.push(url); return { ok: true }; } },
    playQueue: queue,
    perception: {
      enabled: true,
      state: { ok: true, game: 'Dice', lobby: ['Dice', 'Mines', 'Plinko'] },
      async sample() {},
    },
    speak: async () => {},
  });
  agent.nextRotateAt = Date.now() - 1;
  agent.start();
  try {
    await waitFor(() => nav.length > 0);
  } finally {
    agent.stop();
  }
  assert.ok(nav.length >= 1);
  assert.match(nav[0], /housegames-mines/i);
  assert.equal(picks, 0);
});

test('brain lobby pick is used, and a perception failure stays on the scripted rotate', async () => {
  // The playable whitelist is what stops the agent opening a table that cannot resolve;
  // this test runs with Plinko allowed so the brain pick is exercised.
  const prevPlayable = process.env.PLAYABLE_GAMES;
  process.env.PLAYABLE_GAMES = 'Dice,Plinko,Mines';
  try {
  const nav = [];
  const agent = new AgentLoop({
    brain: {
      offline: false,
      async pickGame() { return 'Plinko'; },
      async say() { return { text: '', fallback: true }; },
    },
    tools: diceTools(),
    game: { async navigate(url) { nav.push(url); return { ok: true }; } },
    perception: {
      enabled: true,
      state: { ok: true, game: 'Dice', lobby: ['Dice', 'Mines', 'Plinko'], round: 'idle' },
      async sample() {},
    },
    speak: async () => {},
  });
  agent.nextRotateAt = Date.now() - 1;
  agent.start();
  try {
    await waitFor(() => nav.length > 0);
  } finally {
    agent.stop();
  }
  assert.match(nav[0], /housegames-plinko/i);
  const delta = agent.nextRotateAt - Date.now();
  assert.ok(delta >= 10 * 60 * 1000 - 5000, `rotate in ${delta}ms`);
  assert.ok(delta <= 60 * 60 * 1000);

  const scripted = [];
  let picks = 0;
  const fallback = new AgentLoop({
    brain: {
      offline: false,
      async pickGame() { picks += 1; throw new Error('llm down'); },
      async say() { return { text: '', fallback: true }; },
    },
    tools: diceTools(),
    game: { async navigate(url) { scripted.push(url); return { ok: true }; } },
    perception: {
      enabled: true,
      state: { ok: false, lobby: [] },
      async sample() { throw new Error('dom down'); },
    },
    speak: async () => {},
  });
  fallback.nextRotateAt = Date.now() - 1;
  fallback.start();
  try {
    await waitFor(() => scripted.length > 0);
  } finally {
    fallback.stop();
  }
  assert.match(scripted[0], /housegames-/i);
  assert.doesNotMatch(scripted[0], /housegames-dice/i);
  assert.equal(picks, 0);
  if (prevPlayable === undefined) delete process.env.PLAYABLE_GAMES;
  else process.env.PLAYABLE_GAMES = prevPlayable;
  } finally {
    if (prevPlayable === undefined) delete process.env.PLAYABLE_GAMES;
    else process.env.PLAYABLE_GAMES = prevPlayable;
  }
});

test('bet stays on the zero check when perception throws', async () => {
  let zeros = 0;
  const agent = new AgentLoop({
    brain: { offline: true, async say() { return { text: '', fallback: true }; } },
    tools: diceTools(),
    game: { async ensureBetZero() { zeros += 1; return { ok: true, set: 0 }; } },
    perception: {
      enabled: true,
      state: { ok: true, game: 'Dice', lobby: ['Mines'] },
      async sample() { throw new Error('dom down'); },
    },
    speak: async () => {},
  });
  agent.nextRotateAt = Date.now() + 60 * 60 * 1000;
  agent.lastPlayAt = Date.now();
  agent.lastTuneAt = Date.now();
  agent.lastSpokeAt = Date.now();
  agent.start();
  try {
    await waitFor(() => zeros > 0);
  } finally {
    agent.stop();
  }
  assert.ok(zeros >= 1);
});
