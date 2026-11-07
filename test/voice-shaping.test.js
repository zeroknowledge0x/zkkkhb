// Voice shaping: what the synth is asked to say, minus the markup, plus the human bits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareLine, speakable, stripSpeechTags } from '../src/tts-xai.js';

test('symbols become spoken words', () => {
  assert.equal(speakable('14.9x on Dice'), '14.9 times on Dice');
  assert.equal(speakable('$1,240 left'), '1,240 dollars left');
  assert.equal(speakable('up 12% today'), 'up 12 percent today');
  assert.equal(speakable('Rp 50.000'), '50.000 rupiah');
  assert.equal(speakable('mines / dice'), 'mines or dice');
});

test('long lines open with a breath, short ones do not', () => {
  const long = prepareLine('Two misses on dice chat, nothing on the board, so we load it again now', 'chill');
  assert.match(long[0], /^\[breath\]/);

  const short = prepareLine('Nice pop.', 'chill');
  assert.equal(short[0], 'Nice pop.');
});

test('a win is loud, gets a laugh, and stays inside one tag envelope', () => {
  const chunks = prepareLine('There it is, 14.9x on dice.', 'win');
  const last = chunks[chunks.length - 1];
  assert.match(last, /^<loud>/);
  assert.match(last, /\[laugh\]<\/loud>$/);
  assert.match(last, /14\.9 times/);
  assert.doesNotMatch(last, /\{\s*"emotion"/);
});

test('markup never reaches the fallback voice', () => {
  const plain = stripSpeechTags('<loud>big hit [pause] chat</loud> [laugh]');
  assert.equal(plain, 'big hit chat');
  assert.doesNotMatch(plain, /[\[<]/);
});
