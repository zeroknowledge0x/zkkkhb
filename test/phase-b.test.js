// Phase B offline checks: cue parse + strip, viewer-fact injection, no spoken JSON.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentLoop } from '../src/agent.js';
import { Brain, shapeSpoken } from '../src/brain.js';
import { gestureFromCue, resolveExpression, takeHostCue } from '../src/host-cue.js';
import { ViewerMemory } from '../src/memory.js';

const LEAK = /[{}]|"emotion"|"gesture"|\bjson\b/i;

function spoken(raw) {
  const cue = takeHostCue(raw);
  assert.doesNotMatch(cue.text, LEAK, `spoken leak from: ${raw}`);
  return cue;
}

test('cue trailer, prefix, and fence are stripped and allowlisted', () => {
  const trailer = spoken('Nice hit, chat. {"emotion":"win","gesture":"nod"}');
  assert.equal(trailer.text, 'Nice hit, chat.');
  assert.equal(trailer.emotion, 'win');
  assert.equal(trailer.gesture, 'nod');

  const prefix = spoken('{"emotion":"laugh","gesture":"shrug"} That miss was comedy.');
  assert.equal(prefix.text, 'That miss was comedy.');
  assert.equal(prefix.emotion, 'laugh');
  assert.equal(prefix.gesture, 'shrug');

  const fence = spoken('Still here.\n```json\n{"emotion":"chill","gesture":"none"}\n```');
  assert.equal(fence.text, 'Still here.');
  assert.equal(fence.emotion, 'chill');
  assert.equal(fence.gesture, 'none');

  const mid = spoken('Line {"emotion":"Hype","gesture":"lookchat"} mid');
  assert.equal(mid.text, 'Line mid');
  assert.equal(mid.emotion, 'hype');
  assert.equal(mid.gesture, 'lookChat');
});

test('bad cue values are dropped, the blob is not spoken, hint still applies', () => {
  const bad = spoken('Still spinning. {"emotion":"explode","gesture":"wave"}');
  assert.equal(bad.text, 'Still spinning.');
  assert.equal(bad.emotion, null);
  assert.equal(bad.gesture, null);
  assert.equal(resolveExpression(bad.emotion, 'idle', bad.text), null);

  const loose = spoken('Yo. {emotion: "win", gesture: "nod"}');
  assert.equal(loose.text, 'Yo.');
  assert.equal(loose.emotion, 'win');
  assert.equal(loose.gesture, 'nod');

  const cut = spoken('Nice hit. {"emotion": "win", "gesture":');
  assert.equal(cut.emotion, 'win');
  assert.doesNotMatch(cut.text, LEAK);

  const other = spoken('Hello {"action":"wait","say":"nope"} there');
  assert.equal(other.text, 'Hello there');
  assert.equal(other.emotion, null);
  assert.equal(other.gesture, null);

  const braces = takeHostCue('I meant {braces} in that sentence.');
  assert.match(braces.text, /\{braces\}/);
});

test('expressionHint remains the fallback; an explicit cue wins', () => {
  assert.equal(resolveExpression(null, 'react:win', 'quiet table'), 'win');
  assert.equal(resolveExpression(null, 'idle', 'that was a nice win'), 'win');
  assert.equal(resolveExpression('neutral', 'react:win', 'nice win'), 'neutral');
  assert.equal(resolveExpression('laugh', 'idle', 'hello chat'), 'laugh');
  assert.equal(resolveExpression(null, 'react:lose', 'eh'), 'chill');
  const none = gestureFromCue('none');
  assert.equal(none.set, true);
  assert.equal(none.gesture, null);
  const nod = gestureFromCue('nod');
  assert.equal(nod.gesture.kind, 'nod');
  assert.equal(nod.gesture.ms, 1100);
  assert.equal(gestureFromCue(null).set, false);
  assert.equal(gestureFromCue('lookChat').gesture.ms, 1300);
});

test('shapeSpoken never returns a cue blob as the line', () => {
  const samples = [
    'Mines again. {"emotion":"hype","gesture":"lookChat"}',
    '{"emotion":"neutral","gesture":"none"} Just watching the table.',
    '```json\n{"emotion":"laugh","gesture":"shrug"}\n``` Worth a chuckle.',
  ];
  for (const raw of samples) {
    const shaped = shapeSpoken(raw, 'reply');
    assert.equal(shaped.fallback, false);
    assert.doesNotMatch(shaped.text, LEAK);
    assert.ok(shaped.text.length > 3);
  }
  const idle = shapeSpoken('{"emotion":"win","gesture":"nod"}', 'idle');
  assert.equal(idle.fallback, true);
  assert.equal(idle.text, '');
});

function memFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hubie-mem-')), 'viewers.json');
}

test('viewer memory stores topics, jokes, and win/lose reactions within caps', () => {
  const memory = new ViewerMemory(memFile());
  memory.remember('sam', 'plinko is cursed and I love it');
  assert.equal(memory.factsFor('sam', 'plinko').length, 0, 'first visit injects nothing');

  memory.remember('sam', 'that mines pun was a joke lol honestly');
  const early = memory.peek('sam');
  assert.equal(early.lastBit.kind, 'joke');
  assert.ok(early.topics.some((t) => t.text === 'plinko'));
  const facts = memory.factsFor('sam', 'play plinko again');
  assert.ok(facts.length >= 1 && facts.length <= 2);
  assert.ok(facts.some((f) => /plinko/i.test(f)));
  assert.ok(facts.every((f) => !LEAK.test(f)));

  memory.remember('sam', 'gg that was a nice win');
  memory.remember('sam', 'rip that bust was unlucky');
  memory.remember('sam', 'remember when you said the grid was hungry');
  const v = memory.peek('sam');
  assert.equal(v.lastBit.kind, 'reference');
  assert.deepEqual(v.reactions.map((r) => r.kind), ['win', 'lose']);
  assert.ok(v.topics.length <= 4);

  const cold = memory.factsFor('sam', 'zzzz uniquequery');
  assert.ok(cold.length >= 1 && cold.length <= 2);

  for (let i = 0; i < 10; i++) memory.remember('cap', `moose${i} river candle lantern`);
  const capped = memory.peek('cap');
  assert.equal(capped.topics.length, 4);
  assert.equal(capped.lines.length, 6);
  assert.match(capped.topics.at(-1).text, /^moose9/);

  for (let i = 0; i < 5; i++) memory.remember('cap', `gg huge hit clutch ${i} nice win`);
  assert.equal(memory.peek('cap').reactions.length, 3);

  memory.remember('cap', `this joke lol ${'x'.repeat(200)}`);
  assert.ok(memory.peek('cap').lastBit.text.length <= 80);
  assert.equal(memory.peek('cap').lastBit.kind, 'joke');
});

test('viewer file stays under the byte cap', () => {
  const file = memFile();
  const memory = new ViewerMemory(file, { maxBytes: 2000 });
  for (let i = 0; i < 40; i++) {
    memory.remember(`user${i}`, 'talking about the slow table today folks');
    memory.remember(`user${i}`, 'still talking about that slow table after');
  }
  memory.save();
  const size = fs.statSync(file).size;
  assert.ok(size <= 2000, `viewers.json is ${size} bytes`);
  assert.ok(memory.size < 40);
  assert.ok(memory.size >= 1);
});

function mockBrain(content, { memory = null, key = 'test-key' } = {}) {
  const calls = [];
  const brain = new Brain(
    { llmKey: key, llmUrl: 'http://127.0.0.1:9/v1/chat', llmModel: 'test' },
    {
      memory,
      fetchImpl: async (_url, opts) => {
        calls.push(JSON.parse(opts.body));
        if (content instanceof Error) throw content;
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

test('reply prompt gets one or two viewer facts and the spoken line has no JSON', async () => {
  const memory = new ViewerMemory(memFile());
  memory.remember('sam', 'plinko is cursed and I love it');
  memory.remember('sam', 'spin it again please');
  const { brain, calls } = mockBrain('Mines can wait, Sam. {"emotion":"hype","gesture":"nod"}', { memory });
  const shaped = await brain.say('reply', { name: 'sam', text: 'plinko' });
  assert.equal(shaped.fallback, false);
  assert.equal(shaped.emotion, 'hype');
  assert.equal(shaped.gesture, 'nod');
  assert.equal(shaped.text, 'Mines can wait, Sam.');
  assert.doesNotMatch(shaped.text, LEAK);
  assert.doesNotMatch(brain.history.at(-1).content, LEAK);

  const system = calls[0].messages[0].content;
  assert.match(system, /lookChat/);
  const section = system.split('VIEWER:\n')[1].split('\n\n')[0];
  const bullets = section.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(bullets.length >= 1 && bullets.length <= 2);
  assert.match(section, /plinko/i);

  const first = new ViewerMemory(memFile());
  first.remember('ada', 'what is plinko exactly');
  const fresh = mockBrain('Ada, it is just a board.', { memory: first });
  await fresh.brain.say('reply', { name: 'ada', text: 'what is plinko exactly' });
  assert.doesNotMatch(fresh.calls[0].messages[0].content, /^VIEWER:/m);
});

test('idle prompt continues the last spoken lines; canned only when the brain fails', async () => {
  const { brain, calls } = mockBrain('Still chewing on that grid. {"emotion":"chill","gesture":"none"}');
  brain.noteSpoken('Hey Sam, welcome in.', 'greet:new');
  brain.noteSpoken('Mines is eating the play chips.', 'idle');
  brain.noteSpoken('I told you that grid was hungry.', 'react:lose');
  assert.equal(brain.spoken.length, 2);
  assert.equal(brain.tableMood, 'lose');

  const shaped = await brain.say('idle', { segment: 'chill', game: 'mines' });
  assert.equal(shaped.fallback, false);
  assert.equal(shaped.emotion, 'chill');
  assert.equal(shaped.gesture, 'none');
  assert.doesNotMatch(shaped.text, LEAK);
  const user = calls[0].messages.at(-1).content;
  assert.match(user, /chill/);
  assert.match(user, /mines/i);
  assert.match(user, /Mines is eating the play chips/);
  assert.match(user, /I told you that grid was hungry/);
  assert.equal(calls[0].messages.filter((m) => m.role === 'user').length, 1);

  const down = mockBrain(new Error('socket hang up'));
  const failed = await down.brain.say('reply', { name: 'sam', text: 'you there' });
  assert.equal(failed.fallback, true);
  assert.match(failed.text, /sam/i);
  assert.doesNotMatch(failed.text, LEAK);

  const offline = new Brain({ llmKey: '' }, {});
  const idle = await offline.say('idle', { segment: 'play' });
  assert.equal(idle.fallback, true);
  assert.equal(idle.text, '');

  const { brain: op, calls: opCalls } = mockBrain('{"action":"wait","target":null,"say":null,"reason":"ok"}');
  const raw = await op.say('agent', { observation: { game: { ready: true } } });
  assert.equal(typeof raw, 'string');
  assert.match(raw, /"action"/);
  assert.match(opCalls[0].messages[0].content, /"action"/);
  assert.doesNotMatch(opCalls[0].messages[0].content, /lookChat/);
});

function liveTools() {
  return {
    reportAll() {
      return {
        game: {
          ready: true,
          hasFrame: true,
          url: 'https://www.housebets.com/games/housegames-mines',
          title: 'Mines',
          clickables: [{ text: 'Bet', tag: 'button' }],
          bodySnippet: '',
        },
        stream: { speaking: false },
      };
    },
  };
}

function armIdle(agent) {
  const now = Date.now();
  agent.lastBetCheckAt = now;
  agent.lastPlayAt = now;
  agent.lastTuneAt = now;
  agent.lastSpokeAt = now - 120000;
  agent.idleSpeakMs = 60000;
  agent.speakCooldownMs = 0;
}

async function waitFor(fn, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
}

test('idle uses the brain line when the brain is up', async () => {
  const seen = [];
  const brain = {
    offline: false,
    async say(kind, payload) {
      seen.push({ kind, payload });
      return {
        text: 'Still on that mines thread, chat.',
        emotion: 'chill',
        gesture: 'none',
        fallback: false,
      };
    },
  };
  const spoken = [];
  const agent = new AgentLoop({
    brain,
    tools: liveTools(),
    speak: async (text, reason, meta) => { spoken.push({ text, reason, meta }); },
    getSegment: () => 'chill',
    idleSpeakMs: 60000,
    speakCooldownMs: 0,
  });
  armIdle(agent);
  agent.start();
  try {
    await waitFor(() => spoken.length > 0);
  } finally {
    agent.stop();
  }
  assert.ok(spoken.length >= 1, `no line, last=${agent.lastDecision?.reason}`);
  assert.equal(seen[0].kind, 'idle');
  assert.equal(seen[0].payload.segment, 'chill');
  assert.match(seen[0].payload.game, /mines/);
  assert.equal(spoken[0].text, 'Still on that mines thread, chat.');
  assert.equal(spoken[0].meta.expression, 'chill');
  assert.equal(spoken[0].meta.gestureSet, true);
  assert.equal(spoken[0].meta.gesture, null);
  assert.doesNotMatch(spoken[0].text, LEAK);
});

test('idle stays on the canned pool when the brain is offline', async () => {
  let calls = 0;
  const brain = {
    offline: true,
    async say() { calls += 1; return { text: 'should not speak', fallback: false }; },
  };
  const spoken = [];
  const agent = new AgentLoop({
    brain,
    tools: liveTools(),
    speak: async (text) => { spoken.push(text); },
    getSegment: () => 'play',
    idleSpeakMs: 60000,
    speakCooldownMs: 0,
  });
  armIdle(agent);
  agent.start();
  try {
    await waitFor(() => spoken.length > 0);
  } finally {
    agent.stop();
  }
  assert.equal(calls, 0);
  assert.ok(spoken.length >= 1, `no canned line, last=${agent.lastDecision?.reason}`);
  assert.notEqual(spoken[0], 'should not speak');
  assert.doesNotMatch(spoken[0], LEAK);
});
