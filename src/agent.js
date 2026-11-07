// Agent loop: every 1 s the tools sample the live state, the brain reads that report and
// returns one strict-JSON action, and the loop applies it. No timer invents rounds here.
import { log } from './log.js';
import { isPlayable } from './play-queue.js';
import { sanitize } from './brain.js';
import { gestureFromCue } from './host-cue.js';
import { chooseRotateGame, groundReaction } from './perceive.js';

const TICK_MS = 1000;
const JEV_MIN_MS = 4000; // HTTP Jev every tick saturates RDP CPU/audio
const ACTIONS = new Set(['wait', 'reload', 'click', 'navigate', 'speak', 'silence', 'heal']);
// Talk worker: independent of play, capped queue. Lower number = spoken first and kept
// longer: greet(0) > queue(1) > reply(2) > react:win(3) > react:lose(4) > idle(5).
const TALK_QUEUE_MAX = 3;
// Chat lines (greet, queue ack, reply) outgrow the flavour cap. A burst of real
// viewers has to stay queued until the mouth is free; idle/react still cap at 3.
const CHAT_TALK_MAX = 20;
export const TALK_GREET = 0;
export const TALK_QUEUE = 1;
export const TALK_REPLY = 2;
export const TALK_WIN = 3;
export const TALK_LOSE = 4;
export const TALK_IDLE = 5;
// Freshness is measured on the wall clock, not on the queue slot. An idle/outcome
// candidate older than this is no longer "now" and must not speak after a greet/reply.
const TALK_FRESH_MS = 2000;

export function talkPriority(reason) {
  const tag = String(reason || '');
  if (/^greet/i.test(tag)) return TALK_GREET;
  if (/^queue/i.test(tag)) return TALK_QUEUE;
  if (/^(reply|chat)/i.test(tag)) return TALK_REPLY;
  if (/^react:win/i.test(tag)) return TALK_WIN;
  if (/^react:lose/i.test(tag)) return TALK_LOSE;
  return TALK_IDLE;
}

// Play policy: only short, anchored labels are real game cards. Long marketing copy
// ("Meet the house...", "Originals ... more") mentions the same words and used to win.
const GAME_LABEL = /^(dice|mines?|crash|limbo|plinko|blackjack|keno|wheel|hilo|dragon\s*tower|tower|max\s*win)\b/i;
const GAME_SLUG = /dice|mines?|crash|limbo|plinko|blackjack|keno|wheel|hilo|tower|max-?win/i;
const PROMO_TEXT = /meet the house|made by|originals\b.*more|mini player|play .+ in the|in the mini/i;
const DEMO_CONTROL = /play demo|demo play|^demo$/i;
const SHORT_LABEL = 40;
const ROTATE_MS_MIN = 10 * 60 * 1000; // random Originals switch
const ROTATE_MS_MAX = 60 * 60 * 1000;
function randRotateMs() {
  return ROTATE_MS_MIN + Math.floor(Math.random() * (ROTATE_MS_MAX - ROTATE_MS_MIN + 1));
}

// Canonical Originals paths - full game page, never mini-player (?launch=).
const ORIGINAL_SLUG = {
  dice: 'housegames-dice',
  mines: 'housegames-mines',
  mine: 'housegames-mines',
  limbo: 'housegames-limbo',
  plinko: 'housegames-plinko',
  blackjack: 'housegames-blackjack',
  keno: 'housegames-keno',
  wheel: 'housegames-wheel',
  hilo: 'housegames-hilo',
  tower: 'housegames-dragon-tower',
  'dragon tower': 'housegames-dragon-tower',
  'max win': 'housegames-max-win',
  maxwin: 'housegames-max-win',
};
function originalsUrl(game) {
  const key = String(game || '').trim().toLowerCase();
  const slug = ORIGINAL_SLUG[key] || (GAME_SLUG.test(key) ? `housegames-${key.replace(/\s+/g, '-')}` : null);
  return slug ? `https://www.housebets.com/games/${slug}` : null;
}

// In-game free play: short, anchored controls only. Anything longer is marketing copy.
// manual/auto are mode toggles, not free-play actions - they made playPolicy click Manual every ~8s.
// cash out is situational like manual/auto: leaving it in made playPolicy spam Cash out every ~8s after a Mines round.
const INGAME_CONTROL = /^(auto\s*pick|hit|stand|double|deal|(?:place\s*)?bet|roll|play|start|go|drop|pick|reveal|higher|lower|red|black|over|under|min|max)$/i;
const TUNE_CONTROL = /^(win chance|payout|target|multiplier|difficulty|tiles|mines count)$/i;
const INGAME_SHORT = 24;
const BET_CHECK_MS = 20000;
const TUNE_MS = 20000;
// Mines: between rounds there is no Bet, only the tile grid. Pick a few safe tiles per
// round instead of idling until heal:stuck. Tile labels are numeric ("1") or synthetic
// ("tile 3") from game.js; Cash out is never in the free-control set.
const MINES_TILE_MS = 5000;
const MINES_TILE_MAX = 3;
const MINES_TILE_LABEL = /^(?:\d{1,3}|tile\s*\d+)$/i;
// After a chat-queued game lands, stay on it at least this long before the next queue hop.
const QUEUE_HOLD_MS = 45000;
// Hard gate: a third-party slot/provider (or a /game/ URL that is not an Original).
const NON_ORIGINAL = /slots?|pragmatic|hacksaw|evolution|netent|playngo|\/game\/(?!.*(dice|mines|crash|limbo|plinko|blackjack|keno|wheel))/i;

// Demo-word diet: these pools stay almost entirely clear of "demo" so the voice does not
// chant the compliance word every line. The overlay footer still carries DEMO PLAY ONLY.
// Spoken lines stay under 18 words and lean on contractions: a person talking, not a
// brand account reading a script. The demo compliance word stays on the overlay.
const IDLE_LINES = [
  'Still here, still spinning. Zero stake, full chatter.',
  'Feed looks clean. Say hi if you just hopped in.',
  "Quiet second. Next roll's coming, chips are free.",
  "Sloth mode. Chat's running the whole show anyway.",
  "Nothing on the line but pride, and I'm guarding mine.",
  "I've been spinning so long I forgot what day it is.",
  "House is quiet, I'm quieter. Table stays cozy.",
  "Lurkers welcome. I'd be lurking too if I could.",
  'Zero stakes, zero stress. Just vibes and a calm sloth.',
  'Somebody say something. I can only roast silence so long.',
];
const WIN_LINES = [
  "Ey, that hit. Luck's finally returning my calls.",
  'Ooh, that landed. Vibes up for a second.',
  'There it is. I called it, nobody saved the receipt.',
  "Win pop. I'm smug and it's completely free.",
  'Look at that. Play chips found a friend.',
  "Clean hit. Chat, act surprised, I'm busy being smug.",
  'That one was pretty. Still play money, still gorgeous.',
  'Big yep from me. I said it, table agreed.',
  "Ayy, we take those. House isn't even mad.",
  "Hit confirmed. I'm insufferable for the next two minutes.",
  'Nice little pop. Somebody give me a whistle.',
  'Yep, that landed. Calm, smug, zero dollars richer.',
];
const LOSE_LINES = [
  'Ayy, that miss. House smiled.',
  'Oop, gone. We laugh it off.',
  'Eh, lose. Chips took the L, we move.',
  "That one hurt my feelings. Wallet's untouched though.",
  "Miss. I'm not mad, I'm just gonna stare at the wall.",
  'Nope. I predicted that perfectly wrong, as usual.',
  "Wiped. Great. I'll pretend that round never happened.",
  "Lost again. My pride's got a losing streak too.",
  'Oof. Somebody in chat called that and I ignored them.',
  'Missed it. Still zero dollars, still zero dignity.',
  "That was tragic and I've decided to laugh instead.",
  "Another L. Chat, don't console me, I feed on this.",
];
const HYPE_LINES = [
  'Rolling again. Fingers crossed for a fun pop.',
  "Bet's zero, energy isn't. Here we go.",
  'Another toss. Chat, call it with me.',
  "Okay chat, eyes on the table, let's see something silly.",
  "Fresh round up. I've got a good feeling and no money on it.",
  "Button's hot, stakes are zero, hype's fully real.",
  "Let's go, chat. Loudest one wins nothing, but still.",
  'New roll cooking. Lock in, pretend this matters.',
];
// Chill segment: the table is background, the room is the show. Deliberately distinct
// from the play-segment hype so a segment change is audible without moving any timer.
const CHILL_LINES = [
  "No rush. Table's just breathing in the background.",
  "Chill hour. I'm mostly here for the company.",
  'Slow roll. Nothing needs to happen this second.',
  'Quiet stretch. Perfect time to just sit a minute.',
  'Low stakes, low volume. Exactly how I like it.',
  'Nothing to chase. Chat can just hang out.',
  'Soft mode. The sloth is horizontal.',
  'Take a breath with me. The spins can wait.',
  'Calm table, calm sloth, zero pressure.',
  "If you're here just to lurk, that's the whole vibe.",
];
// Chat-pick segment: invite the next game call without naming the compliance word.
const CHAT_PICK_LINES = [
  "Chat, what's next? Call a game and I'll open it.",
  'Your pick, chat. Dice, Mines, Plinko, say it.',
  "Next table's yours. Type it and I'll switch.",
  'Chat runs the rotation. Name the next game.',
  'One game, one word. Where do we go next?',
  "Call the next one, chat. I'm just the sloth with the keys.",
];

// Random pick that avoids recent repeats; remembers the last few picks in-place.
function pickLine(pool, recentArr, recentMax = 5) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const recent = Array.isArray(recentArr) ? recentArr : [];
  const fresh = pool.filter((line) => !recent.includes(line));
  const source = fresh.length ? fresh : pool;
  const line = source[Math.floor(Math.random() * source.length)];
  if (Array.isArray(recentArr)) {
    recentArr.push(line);
    while (recentArr.length > recentMax) recentArr.shift();
  }
  return line;
}

export class AgentLoop {
  constructor({
    brain,
    tools,
    game = null,
    jev = null,
    perception = null,
    playQueue = null,
    speak = null,
    setGesture = null,
    getSegment = null,
    onUrgent = null,
    speakCooldownMs = 18000,
    actCooldownMs = 4000,
    idleSpeakMs = 45000,
  } = {}) {
    if (!brain) throw new Error('AgentLoop needs a brain');
    if (!tools) throw new Error('AgentLoop needs tools');
    this.brain = brain;
    this.tools = tools;
    this.game = game;
    this.jev = jev;
    this.perception = perception;
    this.playQueue = playQueue;
    this.speak = speak;
    this.setGesture = setGesture;
    this.getSegment = getSegment;
    this.onUrgent = onUrgent;
    this.speakCooldownMs = speakCooldownMs;
    this.actCooldownMs = actCooldownMs;
    this.idleSpeakMs = idleSpeakMs;
    this.timer = null;
    this.stopped = false;
    // Play and talk are separate workers: TTS must never stall a Bet/rotate tick.
    this.playInFlight = false;
    this.talkInFlight = false;
    this.talkQueue = [];
    this.ticks = 0;
    this.skips = 0;
    this.failures = 0;
    this.startedAt = Date.now();
    this.lastSpokeAt = 0;
    this.lastAct = null;
    this.lastActAt = 0;
    this.lastObs = null;
    this.lastDecision = null;
    this.lastJevAt = 0;
    this.lastObsKey = '';
    this.lastJevDecision = null;
    this.lastPlayAt = 0;
    this.playRotate = 0;
    this.nextRotateAt = Date.now() + randRotateMs();
    this.lastBetCheckAt = 0;
    this.lastTuneAt = 0;
    this.minesPicks = 0;
    this.minesPickTarget = 0;
    this.lastOutcomeResult = null;
    this.lastReactAt = 0;
    this.lastReactTag = null;
    this.loseStreak = 0;
    this.recentReactLines = [];
    this.recentIdleLines = [];
    this.queueHoldUntil = 0;
    this.talkSeq = 0;
    // One idle compose at a time. The play tick must not wait on the brain.
    this.idleCompose = false;
  }

  start() {
    if (this.stopped || this.timer) return this;
    const mins = Math.round((this.nextRotateAt - Date.now()) / 60000);
    log(`agent: loop started (${TICK_MS} ms tick, reportAll every tick, rotate in ~${mins} min)`);
    this.#schedule(0);
    return this;
  }

  stop() {
    this.stopped = true;
    this.idleCompose = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.talkQueue = [];
  }

  get status() {
    return {
      ticks: this.ticks,
      skips: this.skips,
      failures: this.failures,
      lastAction: this.lastDecision?.action || null,
      playInFlight: this.playInFlight,
      talkInFlight: this.talkInFlight,
      talkQueue: this.talkQueue.length,
    };
  }

  #schedule(ms) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.#tick(); }, ms);
  }

  #next(t0) {
    this.#schedule(Math.max(0, TICK_MS - (Date.now() - t0)));
  }

  async #tick() {
    if (this.stopped) return;
    this.ticks++;
    const t0 = Date.now();

    // Sampling is cheap and always happens, even when the previous LLM call is still open.
    let obs = null;
    try {
      obs = this.tools.reportAll();
      this.lastObs = obs;
    } catch (err) {
      log(`agent: report failed: ${err.message}`);
    }
    if (!obs) {
      this.#next(t0);
      return;
    }

    // Perception is best-effort. A throw, a timeout, or an empty read leaves the
    // scripted Bet-0 path in place.
    if (this.perception) {
      try {
        await this.perception.sample();
        if (this.perception.state) obs.perception = this.perception.state;
      } catch (err) {
        log(`agent: perception failed: ${err.message}`);
      }
    }

    // Play worker: clicks/navigate/reload/heal/bet:zero only. It never awaits TTS, so
    // while a line is speaking the next tick still clicks Bet / bet:zero / rotates.
    if (this.playInFlight) {
      this.skips++;
      log('agent: play tick skipped (play in flight)');
    } else {
      this.playInFlight = true;
      try {
        const decision = this.#asPlay(await this.#decide(obs));
        this.lastDecision = decision;
        await this.#apply(decision, obs);
        this.failures = 0;
      } catch (err) {
        this.failures++;
        log(`agent: decision failed: ${err.message}`);
        const fb = this.#asPlay(this.#fallback(obs));
        this.lastDecision = fb;
        await this.#apply(fb, obs).catch(() => {});
      } finally {
        this.playInFlight = false;
      }
    }

    // Talk worker: fire-and-forget. Runs whether or not play is in flight, respects
    // speakCooldownMs and stream.speaking, and never blocks this tick.
    this.#pumpTalk(obs);
    this.#next(t0);
  }

  // Cascade: Jev classifies the tick first (one cheap HTTP call, 4 s budget). Only a
  // confident wait/reload/speak/silence is auto-applied; click/navigate and low confidence
  // defer to the LLM, which owns targets and free text.
  async #decide(obs) {
    const policy = await this.#policyDecide(obs);
    if (policy) return policy;
    const jev = await this.#decideJev(obs);
    if (jev) return jev;
    // On a live Originals table, stay on deterministic fallback - LLM JSON fails
    // were spamming the log and flooding TTS with the same Dice lines.
    const url = String(obs?.game?.url || '');
    if (/housegames-|\/games\//i.test(url) || this.brain.offline) return this.#fallback(obs);
    const raw = await this.brain.say('agent', { observation: obs });
    const parsed = parseDecision(raw);
    if (!parsed) {
      log(`agent: bad JSON from brain (using fallback): ${String(raw).slice(0, 80)}`);
      return this.#fallback(obs);
    }
    const decision = normalizeDecision(parsed);
    if (!decision) {
      log(`agent: bad action from brain (using fallback): ${String(parsed?.action).slice(0, 40)}`);
      return this.#fallback(obs);
    }
    return decision;
  }


  // Deterministic gates - do not ask the LLM to notice a 404.
  async #policyDecide(obs) {
    const g = obs?.game || {};
    const clickables = Array.isArray(g.clickables) ? g.clickables : [];
    const meta = `${g.title || ''} ${g.lastError || ''} ${g.url || ''}`;
    const dom = `${g.bodySnippet || ''} ${clickables.map((c) => c.text || '').join(' ')}`;
    // Self-heal: Kick chat tab / wrong foreground must not steal the stream.
    if (/kick\.com/i.test(String(g.url || '')) || /\bkick\b/i.test(String(g.title || ''))) {
      return { action: 'heal', target: null, say: null, reason: 'policy: healFocus (kick tab)' };
    }
    // Only the legacy broken path is a hard 404. Real Originals often live under /games/
    // or /casino/.../blackjack - treating every /games/ URL as dead caused a click→navigate loop.
    const legacyDead = /unoriginals-crash|\/games\/unoriginals/i.test(String(g.url || ''));
    const notFound = !!g.notFound
      || /\b404\b|page not found/i.test(meta)
      || /\b404\b|page not found|return to home/i.test(dom)
      || legacyDead;
    if (notFound) {
      const casino = 'https://www.housebets.com/casino';
      // Prefer the label the DOM actually shows so clickText lands on the right element.
      const home = clickables.find((c) => /return to home|back to home|^home$/i.test(String(c.text || '').trim()));
      // Prefer navigate to the known-good lobby; click Home as backup when already on site.
      if (legacyDead) {
        return { action: 'navigate', target: casino, say: null, reason: 'policy: 404 path → casino' };
      }
      return {
        action: 'click',
        target: home?.text || 'Return to Home',
        say: null,
        reason: 'policy: 404 → Home',
      };
    }

    // Originals-only: a third-party slot/provider URL is never allowed to stay open.
    if (NON_ORIGINAL.test(String(g.url || ''))) {
      return {
        action: 'navigate',
        target: 'https://www.housebets.com/casino',
        say: null,
        reason: 'policy: originals only',
      };
    }

    // Play policy runs on any non-404 page: queued requests first, then a demo control,
    // then lobby rotation. Deterministic so Jev/LLM never have to guess a game label.
    if (g.blocked || !clickables.length) return null;
    return this.#playPolicy(g, clickables, Date.now());
  }

  async #playPolicy(g, clickables, now) {
    const casino = 'https://www.housebets.com/casino';
    const queued = this.playQueue?.peek?.() || null;
    // Logged-out Originals looks like a demo canvas (Bet replaced by Log in).
    if (/housegames-/i.test(String(g.url || ''))
      && /\blog in\b/i.test(`${g.bodySnippet || ''} ${clickables.map((c) => c.text || '').join(' ')}`)) {
      if (!this._loginWarnedAt || now - this._loginWarnedAt > 120000) {
        this._loginWarnedAt = now;
        log('agent: Housebets session logged out - need RDP Chrome login');
      }
      // Still honor a queue navigate so the right table is open when they log in.
      if (!queued) {
        return { action: 'silence', target: null, say: null, reason: 'policy: login required' };
      }
    }
    if (queued) {
      const dest = originalsUrl(queued.game);
      const onQueued = dest
        ? String(g.url || '').toLowerCase().includes(`/games/${ORIGINAL_SLUG[String(queued.game).trim().toLowerCase()] || ''}`)
          || new RegExp(String(queued.game).replace(/\s+/g, ''), 'i').test(String(g.url || '') + ' ' + String(g.title || ''))
        : new RegExp(String(queued.game).replace(/\s+/g, ''), 'i').test(String(g.url || '') + ' ' + String(g.title || ''));
      // Mini-player / launch= is not the full Originals table - leave it.
      const mini = /[?&]launch=/i.test(String(g.url || ''));
      const loggedOut = /\blog in\b/i.test(`${g.bodySnippet || ''} ${clickables.map((c) => c.text || '').join(' ')}`);
      if (onQueued && !mini && !loggedOut) {
        const done = this.playQueue?.shift?.();
        if (done) {
          this.queueHoldUntil = now + QUEUE_HOLD_MS;
          this.lastPlayAt = now; // fresh stuck-clock for the new table
          log(`agent: queue arrived ${done.game} for ${done.name} (hold ${Math.round(QUEUE_HOLD_MS / 1000)}s)`);
        }
      } else if (onQueued && !mini && loggedOut) {
        // Right table, waiting for RDP login - hold the queue item.
        return { action: 'silence', target: null, say: null, reason: 'queue:await-login' };
      } else if (now < this.queueHoldUntil && /housegames-/i.test(String(g.url || ''))) {
        // Still showcasing the last chat pick - play it; next queue waits.
        // Fall through to in-game free play below.
      } else if (dest) {
        if (this.game) this.game.preferredGame = null;
        return {
          action: 'navigate',
          target: dest,
          say: null,
          reason: `queue:open→${queued.game}`,
        };
      } else {
        const label = this.#gameLabel(queued.game, clickables);
        if (label) {
          return {
            action: 'click',
            target: label,
            say: null,
            reason: `queue:${queued.game}@${queued.name}`,
          };
        }
        if (this.game) this.game.preferredGame = queued.game;
      }
    }

    // Random Originals switch every 10-60 min. Chat queue always wins above.
    // The interval is unchanged. Perception only chooses WHICH title, and only from
    // a lobby list that was actually on screen. No list, or a failed read → the old
    // random slug pick.
    if (!queued && now >= this.nextRotateAt) {
      const labels = this.#shortGames(clickables);
      const scripted = Object.keys(ORIGINAL_SLUG).filter((k) => !k.includes(' '));
      let pick = null;
      let via = 'scripted';
      const observed = this.#observedLobby();
      if (observed.length) {
        let brainPick = null;
        try {
          if (this.brain && !this.brain.offline && typeof this.brain.pickGame === 'function') {
            brainPick = await this.brain.pickGame({
              lobby: observed,
              current: tableName(g),
              state: this.#screenState(),
            });
          }
        } catch (err) {
          log(`agent: rotate brain skipped (${err?.message || err})`);
        }
        try {
          const chosen = chooseRotateGame({
            observed,
            brainPick,
            current: tableName(g),
          });
          if (chosen?.game) {
            pick = chosen.game;
            via = chosen.source;
          }
        } catch (err) {
          log(`agent: rotate choice skipped (${err?.message || err})`);
        }
      }
      if (!pick) {
        const poolNames = (labels.length ? labels : scripted).filter((l) => isPlayable(l));
        const cur = `${g.url || ''} ${g.title || ''}`;
        const others = poolNames.filter((l) => !new RegExp(String(l).replace(/\s+/g, ''), 'i').test(cur));
        const pool = others.length ? others : poolNames;
        if (pool.length) {
          pick = pool[Math.floor(Math.random() * pool.length)];
          via = 'scripted';
        }
      }
      if (pick) {
        const dest = originalsUrl(pick);
        this.nextRotateAt = now + randRotateMs();
        this.lastPlayAt = now;
        if (this.game) this.game.preferredGame = null;
        if (dest) {
          log(`agent: rotate → ${pick} via ${via} (next in ${Math.round((this.nextRotateAt - now) / 60000)} min)`);
          return { action: 'navigate', target: dest, say: null, reason: `rotate:${pick}` };
        }
        log(`agent: rotate → click ${pick} via ${via}`);
        return { action: 'click', target: pick, say: null, reason: `rotate:${pick}` };
      }
      this.nextRotateAt = now + 20000;
    }

    const demo = clickables
      .map((c) => shortLabel(c))
      .find((text) => text && DEMO_CONTROL.test(text));
    if (demo) {
      return { action: 'click', target: demo, say: null, reason: 'demo:play' };
    }

    // Inside a game view: pin stake at 0, then click Bet/Roll from live clickables
    // (shadow-DOM tools must surface these - otherwise Jev only waits/talks).
    if (!this.#inLobby(g)) {
      const free = this.#shortMatches(clickables, INGAME_CONTROL);
      const betTarget = free.find((x) =>
        /^(?:place\s*)?(bet|roll|deal|play|hit|stand|double|higher|lower|red|black|over|under|drop|pick|reveal|start|go)$/i.test(x));
      // Keno needs Auto pick before Bet.
      const autoPick = free.find((x) => /^auto\s*pick$/i.test(x));
      const autoTarget = autoPick && String(this.lastPlayLabel || '').toLowerCase() !== 'auto pick'
        ? autoPick
        : betTarget;
      // Mines free play: once a round starts there is no Bet/Deal, only the tile grid.
      // Click one safe tile every ~5 s (1-3 per round) instead of idling to heal:stuck.
      if (/mines/i.test(`${g.url || ''} ${g.title || ''}`)) {
        if (betTarget || autoTarget) {
          // Bet/Deal visible = previous round over; start a fresh pick budget.
          this.minesPicks = 0;
          this.minesPickTarget = 0;
        } else {
          const tiles = this.#minesTiles(clickables);
          if (tiles.length) {
            if (!this.minesPickTarget) {
              this.minesPickTarget = 1 + Math.floor(Math.random() * MINES_TILE_MAX);
            }
            if (this.minesPicks < this.minesPickTarget
              && now - (this.lastPlayAt || 0) > MINES_TILE_MS) {
              this.minesPicks++;
              this.lastPlayAt = now;
              return { action: 'click', target: null, say: null, reason: 'ingame:mines-tile' };
            }
          } else if (now - (this.lastPlayAt || 0) > 8000) {
            // Pre-round: Bet may not match the short free list - click the label directly.
            this.lastPlayAt = now;
            return { action: 'click', target: 'Bet', say: null, reason: 'ingame:mines-bet' };
          }
        }
      }
      // Stuck heal: no playable control for 40s (e.g. Mines mid-round has no tile pick) → return to Dice.
      // A fresh navigation gets a longer grace: Hilo/Blackjack take a few seconds longer to
      // boot, and bouncing back to Dice mid-load is what made "only Dice works" look true.
      const stuckFrom = Math.max(this.lastPlayAt || this.startedAt, this.lastNavAt || 0);
      const stuckMs = this.lastNavAt && now - this.lastNavAt < 300000 ? 240000 : 40000;
      if (!autoTarget && now - stuckFrom > stuckMs) {
        const dest = originalsUrl('dice');
        this.lastPlayAt = now;
        if (dest) return { action: 'navigate', target: dest, say: null, reason: 'heal:stuck' };
      }
      if (now - this.lastBetCheckAt > BET_CHECK_MS) {
        return { action: 'click', target: null, say: null, reason: 'bet:zero' };
      }
      // min/max are stake helpers (bet:zero owns them); clicking them would refresh lastPlayAt and block heal:stuck.
      const playFirst = autoTarget;
      if (playFirst && now - (this.lastPlayAt || 0) > 8000) {
        this.lastPlayAt = now;
        this.lastPlayLabel = playFirst;
        return { action: 'click', target: playFirst, say: null, reason: 'ingame:free' };
      }
      // Numeric tuning: rewrite a non-bet number input (Limbo target/multiplier) every
      // TUNE_MS. Clicking the label alone never changed the value - the input kept its
      // old number while chat asked for a new target.
      if (now - this.lastTuneAt > TUNE_MS) {
        this.lastTuneAt = now;
        return { action: 'click', target: null, say: null, reason: 'ingame:tune-nudge' };
      }
      // Hold the table between clicks - returning null lets Jev/LLM spam "Dice is up".
      // Speech is queued for the talk worker; play keeps its own fast path.
      const react = this.#outcomeLine({ game: g });
      if (react) {
        this.#enqueueTalk(react.say, react.reason, { eventAt: react.eventAt });
        return { action: 'wait', target: null, say: null, reason: 'ingame:hold' };
      }
      const sinceSpeak = now - (this.lastSpokeAt || this.startedAt);
      if (sinceSpeak > this.idleSpeakMs) {
        this.#queueIdle(g);
        return { action: 'wait', target: null, say: null, reason: 'ingame:hold' };
      }
      return { action: 'wait', target: null, say: null, reason: 'ingame:hold' };
    }
    return null;
  }

  // Tile entries reported by game.js carry `tile: true` (typically empty buttons), or a
  // short numeric/synthetic label. Excludes anything that could be cash out.
  #minesTiles(clickables) {
    const out = [];
    const seen = new Set();
    for (const c of clickables) {
      const text = shortLabel(c);
      if (!c?.tile && !(text && MINES_TILE_LABEL.test(text))) continue;
      if (text && /^(?:cash\s*out|cashout|bet|auto|manual|min|max)$/i.test(text)) continue;
      const key = `${text || ''}@${Math.round(Number(c?.x) || 0)},${Math.round(Number(c?.y) || 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text || 'tile');
    }
    return out;
  }

  // Short, de-duplicated clickable labels matching an anchored control pattern.
  #shortMatches(clickables, pattern) {
    const out = [];
    const seen = new Set();
    for (const c of clickables) {
      const text = shortLabel(c);
      if (!text || text.length > INGAME_SHORT) continue;
      if (!pattern.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }

  // A real game view has a slug in the URL; the lobby is /casino or anything slug-less.
  #inLobby(g) {
    let path = String(g.url || '');
    try {
      const u = new URL(path);
      path = `${u.pathname}${u.search}`;
    } catch { /* keep the raw string */ }
    if (/\/casino\/?$/i.test(path)) return true;
    return !!g.ready && !GAME_SLUG.test(path);
  }

  #shortGames(clickables) {
    const out = [];
    const seen = new Set();
    for (const c of clickables) {
      const text = shortLabel(c);
      if (!text || PROMO_TEXT.test(text)) continue;
      if (!GAME_LABEL.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }

  #gameLabel(game, clickables) {
    const pattern = gamePattern(game);
    if (!pattern) return null;
    // Must START with the game name ("Dice"), not contain it mid-CTA ("Play Dice in...").
    const needle = new RegExp(`^(?:${pattern})\\b`, 'i');
    const candidates = [];
    for (const c of clickables) {
      const text = shortLabel(c);
      if (!text || PROMO_TEXT.test(text)) continue;
      if (!needle.test(text)) continue;
      if (text.length > 20) continue;
      candidates.push({ text, anchor: c?.tag === 'a', len: text.length });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.len - b.len || b.anchor - a.anchor);
    return candidates[0].text;
  }

  async #decideJev(obs) {
    if (!this.jev?.enabled) return null;
    const key = JSON.stringify({
      r: obs?.game?.ready, n: obs?.game?.notFound, b: obs?.game?.blocked,
      u: obs?.game?.url, t: (obs?.game?.title || '').slice(0, 80),
      e: obs?.game?.lastError, f: obs?.game?.hasFrame,
    });
    const now = Date.now();
    // Same page state + recent Jev → reuse (stops 1 Hz HTTP thrash = lag/choppy audio).
    if (key === this.lastObsKey && this.lastJevDecision && now - this.lastJevAt < JEV_MIN_MS) {
      return this.lastJevDecision;
    }
    if (now - this.lastJevAt < JEV_MIN_MS && (this.lastJevDecision?.action === 'wait' || this.lastJevDecision?.action === 'silence')) {
      return this.lastJevDecision;
    }
    const secondsSinceSpeak = this.lastSpokeAt ? (Date.now() - this.lastSpokeAt) / 1000 : null;
    const choice = await this.jev.chooseAction(obs, { secondsSinceSpeak });
    this.lastJevAt = Date.now();
    this.lastObsKey = key;
    if (!choice) {
      log('agent: jev no choice - falling back');
      this.lastJevDecision = null;
      return null;
    }
    const conf = Number(choice.confidence) || 0;
    const action = choice.choice;
    // wait/silence: trust Jev even at lower conf - avoids LLM every tick (lag source).
    if (action === 'wait' || action === 'silence') {
      // Do not trust a wait while the lobby has playable short labels and rotation is due.
      const g = obs?.game || {};
      const clickables = Array.isArray(g.clickables) ? g.clickables : [];
      if (action === 'wait' && this.#inLobby(g) && this.#shortGames(clickables).length
          && now >= this.nextRotateAt) {
        log('agent: jev wait overridden - lobby games available');
        this.lastJevDecision = null;
        return null;
      }
      // On an Originals table with Bet/Roll visible, do not sit on wait - play policy owns the click.
      if ((action === 'wait' || action === 'silence')
          && /housegames-/i.test(String(g.url || ''))
          && clickables.some((c) => /^(bet|roll)$/i.test(String(c.text || '').trim()))) {
        log('agent: jev wait overridden - Bet/Roll visible');
        this.lastJevDecision = null;
        return null;
      }
      log(`agent: jev action=${action} conf=${conf.toFixed(2)}`);
      const d = { action, target: null, say: null, reason: `jev ${action} ${conf.toFixed(2)}` };
      this.lastJevDecision = d;
      return d;
    }
    if (!this.jev.acceptsAction(action, conf)) {
      log(`agent: jev defer action=${action} conf=${conf.toFixed(2)}`);
      this.lastJevDecision = null;
      return null;
    }
    if (action === 'speak') {
      this.#queueIdle(obs?.game);
      log(`agent: jev action=speak conf=${conf.toFixed(2)} (grounded idle)`);
      const d = { action: 'wait', target: null, say: null, reason: `jev speak ${conf.toFixed(2)}` };
      this.lastJevDecision = d;
      return d;
    }
    log(`agent: jev action=${action} conf=${conf.toFixed(2)}`);
    const d = { action, target: null, say: null, reason: `jev ${action} ${conf.toFixed(2)}` };
    this.lastJevDecision = d;
    return d;
  }

  async #apply(d, obs) {
    log(`agent: action=${d.action} reason=${d.reason || '-'}`);
    const now = Date.now();
    if (this.talkInFlight && (d.action === 'click' || d.action === 'navigate'
        || d.action === 'reload' || d.action === 'heal')) {
      log('agent: play still ticks (talk in flight)');
    }

    switch (d.action) {
      case 'reload':
      case 'navigate':
      case 'click': {
        const reason = String(d.reason || '');
        if (d.action === 'click' && reason === 'bet:zero') {
          this.lastBetCheckAt = now;
          this.lastAct = 'bet:zero';
          this.lastActAt = now;
          const res = await this.game?.ensureBetZero?.();
          log(`agent: bet:zero -> ${Number(res?.set) || 0} field(s)`);
          break;
        }
        if (d.action === 'click' && reason === 'ingame:tune-nudge') {
          this.lastTuneAt = now;
          this.lastAct = 'tune-nudge';
          this.lastActAt = now;
          const res = await this.game?.nudgePayoutOrTarget?.();
          const set = Number(res?.set) || 0;
          log(`agent: tune-nudge -> ${set} field(s)${res?.values?.length ? ` (${res.values.join(', ')})` : ''}`);
          // No numeric target on this table: fall back to the label click policy used before.
          if (!set) {
            const tune = this.#shortMatches(obs?.game?.clickables || [], TUNE_CONTROL);
            if (tune.length) {
              const pick = tune[Math.floor(Math.random() * tune.length)];
              const hit = await this.game?.clickText?.(pick);
              log(`agent: tune label ${hit?.ok ? 'ok' : 'miss'} "${pick}"`);
            }
          }
          break;
        }
        if (d.action === 'click' && reason === 'ingame:mines-tile') {
          this.lastAct = 'mines-tile';
          this.lastActAt = now;
          const res = await this.game?.clickMinesTile?.();
          log(`agent: mines tile -> ${res?.ok
            ? `"${res.text || 'tile'}" ${Number(res.total) || '?'} open`
            : res?.reason || 'no-op'}`);
          break;
        }
        if (this.lastAct === d.action && now - this.lastActAt < this.actCooldownMs) {
          log(`agent: ${d.action} throttled`);
          return;
        }
        this.lastAct = d.action;
        this.lastActAt = now;
        if (d.action === 'reload') {
          await this.game?.reload?.();
        } else if (d.action === 'navigate') {
          const dest = String(d.target || '');
          const cur = String(obs?.game?.url || '');
          // Block lobby bounce while already on an Originals table.
          const forceLobby = /^(queue:lobby|rotate:lobby)/.test(String(d.reason || ''));
          if (!forceLobby && /housebets\.com\/casino\/?$/i.test(dest) && GAME_SLUG.test(cur) && !/unoriginals/i.test(cur)) {
            log(`agent: navigate to lobby ignored (in Originals: ${cur.slice(0, 80)})`);
            break;
          }
          if (d.target) {
            // A fresh navigation restarts the stuck clock with a longer grace: the new
            // table needs to boot before "no playable control" means anything.
            this.lastNavAt = Date.now();
            await this.game?.navigate?.(d.target);
          } else {
            log('agent: navigate without target - ignored');
          }
        } else if (d.target) {
          const hit = await this.game?.clickText?.(d.target);
          if (hit?.ok) {
            log(`agent: pointer @ ${hit.x},${hit.y} "${hit.text}"`);
            if (/^(queue|rotate|demo):/.test(reason)) this.lastPlayAt = now;
            if (reason.startsWith('ingame:tune')) this.lastTuneAt = now;
            if (reason.startsWith('queue:')) {
              const done = this.playQueue?.shift?.();
              if (done) log(`agent: queue served ${done.game} for ${done.name}`);
            }
          }
        } else {
          log('agent: click without target - ignored');
        }
        break;
      }
      case 'speak': {
        if (!d.say) {
          log('agent: speak without line - ignored');
          break;
        }
        // Speak only ever leaves the talk worker (#runTalk); never awaited on the play path.
        this.#enqueueTalk(d.say, d.reason || 'speak', { eventAt: d.eventAt });
        break;
      }
      case 'heal': {
        if (this.lastAct === 'heal' && now - this.lastActAt < 5000) break;
        this.lastAct = 'heal';
        this.lastActAt = now;
        const res = await this.game?.healFocus?.();
        log(`agent: healFocus -> ${res?.ok ? res.url : res?.reason || 'no-op'}`);
        break;
      }
      case 'silence':
      case 'wait':
      default:
        break;
    }
  }

  // Any speak decision from Jev/LLM/fallback becomes talk work; play gets a plain hold.
  #asPlay(d) {
    if (!d || d.action !== 'speak') return d;
    if (d.say) this.#enqueueTalk(d.say, d.reason || 'speak', { eventAt: d.eventAt });
    return { action: 'wait', target: null, say: null, reason: 'ingame:hold' };
  }

  // Public entry for the chat path (greetings ride the same priority queue).
  enqueue(say, reason = 'speak', meta = {}) {
    return this.#enqueueTalk(say, reason, meta);
  }

  // Presence intent is attached to the line and played by index.js when playback of
  // that utterance reaches the render clock — never at enqueue time, where it used to
  // fire ~19 s before the audio and die unseen, and not when the synth packet arrives.
  #gestureFor(tag) {
    if (/^react:win/i.test(tag)) return { kind: 'nod', ms: 1100 };
    if (/^react:lose/i.test(tag)) return { kind: 'shrug', ms: 1400 };
    if (/^queue/i.test(tag)) return { kind: 'lookChat', ms: 1100 };
    if (/^(reply|chat)/i.test(tag)) return { kind: 'lookChat', ms: 1300 };
    return null;
  }

  // Drop slot when the queue is full: idle first, then lose. Greet/queue/reply/win are
  // never chosen here; greet is the one line we must never lose.
  #dropIndex() {
    let idx = -1;
    let worst = -1;
    this.talkQueue.forEach((q, i) => {
      if (q.priority >= TALK_LOSE && q.priority > worst) {
        worst = q.priority;
        idx = i;
      }
    });
    return idx;
  }

  // Talk queue: greet(0) > queue(1) > reply(2) > react:win(3) > react:lose(4) > idle(5).
  // Idle/react stay capped at 3. Chat lines are kept (up to CHAT_TALK_MAX) and are
  // not stale-dropped — an 8 s TTL was deleting replies that waited out the 18 s
  // cooldown. A greet is never dropped. Returns false when the line is not queued.
  #enqueueTalk(say, reason = 'speak', meta = {}) {
    const text = String(say || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    const tag = String(reason || 'speak');
    const now = Date.now();
    const priority = talkPriority(tag);
    const isReact = /^react:(win|lose)/i.test(tag);
    const isGreet = priority === TALK_GREET;
    const isChat = priority <= TALK_REPLY;
    const chatId = meta?.chatId || null;
    const dup = this.talkQueue.some((q) => {
      if (q.say !== text) return false;
      if (isChat && chatId) return q.chatId === chatId;
      return true;
    });
    if (dup) {
      log(`agent: talk enqueue deduped "${text.slice(0, 48)}"`);
      return false;
    }
    // A greet or reply means "now". Idle flavour and outcome colour waiting from
    // before it are stale by definition: expire them instead of letting a 17 s-old
    // line play as if it were fresh.
    if (priority <= TALK_REPLY) {
      const before = this.talkQueue.length;
      this.talkQueue = this.talkQueue.filter((q) => {
        const age = now - (q.at || now);
        const stale = q.priority >= TALK_WIN && age > TALK_FRESH_MS;
        if (stale) log(`talk: expired id=${q.id || '?'} reason=${q.reason || '?'} age_ms=${age}`);
        return !stale;
      });
      if (this.talkQueue.length !== before) {
        log(`talk: expired ${before - this.talkQueue.length} stale candidate(s) for ${tag}`);
      }
      // Let a low-priority line that is already sounding yield at the next chunk
      // boundary so this greet/reply starts sooner.
      this.onUrgent?.(priority);
    }
    // Idle/vibes: at most one pending. Stamp lastSpokeAt so playPolicy does not refill every tick.
    if (priority >= TALK_IDLE) {
      if (this.talkInFlight || this.talkQueue.some((q) => q.priority >= TALK_IDLE)) {
        log(`agent: talk enqueue skipped (vibes already pending) "${text.slice(0, 48)}"`);
        return false;
      }
      this.lastSpokeAt = Date.now();
    }
    // At most ONE pending react: latest outcome replaces the old one. This never touches
    // a greet or a chat reply.
    if (isReact) {
      const idx = this.talkQueue.findIndex((q) => /^react:(win|lose)/i.test(q.reason));
      if (idx >= 0) {
        log(`agent: talk react replaced "${this.talkQueue[idx].say.slice(0, 48)}" -> "${text.slice(0, 48)}"`);
        this.talkQueue.splice(idx, 1);
      }
    }
    // Make room. Greets always fit. Chat may grow to CHAT_TALK_MAX and may evict a
    // win for space, never another chat line. Idle/react stay on the small cap.
    if (!isGreet) {
      const cap = isChat ? CHAT_TALK_MAX : TALK_QUEUE_MAX;
      while (this.talkQueue.length >= cap) {
        const drop = this.#dropIndex();
        if (drop >= 0) {
          log(`agent: talk dropped (queue full) "${this.talkQueue[drop].say.slice(0, 48)}"`);
          this.talkQueue.splice(drop, 1);
          continue;
        }
        if (isChat) {
          const win = this.talkQueue.findIndex((q) => q.priority === TALK_WIN);
          if (win >= 0) {
            log(`agent: talk evicted for chat "${this.talkQueue[win].say.slice(0, 48)}"`);
            this.talkQueue.splice(win, 1);
            continue;
          }
        }
        log(`agent: talk enqueue dropped (queue full of protected lines) "${text.slice(0, 48)}"`);
        return false;
      }
    }
    // eventAt is the moment the outcome actually happened (react lines only). It is
    // carried all the way to speak-start so a stale result can be skipped there.
    this.talkQueue.push({
      say: text,
      reason: tag || 'speak',
      priority,
      at: now,
      id: `t${++this.talkSeq}`,
      chatId: meta.chatId || null,
      gesture: meta.gestureSet ? (meta.gesture || null) : this.#gestureFor(tag),
      gestureSet: meta.gestureSet === true,
      expression: meta.expression || null,
      eventAt: isReact ? (Number(meta.eventAt) || now) : null,
    });
    log(`agent: talk enqueue id=t${this.talkSeq} "${text.slice(0, 48)}" (${tag || 'speak'}) q=${this.talkQueue.length}`);
    return true;
  }

  // Talk worker pump: called every tick, never awaited by play. Picks the highest-priority
  // pending line (lowest number) so a greet beats a queued idle/reply. Among equal
  // priorities the oldest line wins (chat FIFO). Chat speaks as soon as the mouth is
  // free — the 18 s cooldown is for react/idle only, so a reply is not deleted for
  // having waited. Nothing starts over an active line.
  #pumpTalk(obs) {
    if (this.stopped || this.talkInFlight || !this.speak || !this.talkQueue.length) return;
    if (obs?.stream?.speaking) return;
    let idx = 0;
    for (let i = 1; i < this.talkQueue.length; i++) {
      if (this.talkQueue[i].priority < this.talkQueue[idx].priority) idx = i;
    }
    const now = Date.now();
    const line = this.talkQueue[idx];
    // Outcome colour older than ~2 s is stale. Chat replies are not.
    if (line.priority >= TALK_WIN && line.eventAt && now - line.eventAt > TALK_FRESH_MS) {
      this.talkQueue.splice(idx, 1);
      log(`talk: stale_drop id=${line.id || '?'} reason=${line.reason || '?'} event_age_ms=${now - line.eventAt}`);
      return;
    }
    if (line.priority > TALK_REPLY) {
      if (now - (this.lastSpokeAt || 0) < this.speakCooldownMs) return;
    }
    this.talkQueue.splice(idx, 1);
    this.#runTalk(line).catch(() => {});
  }

  async #runTalk(line) {
    if (!line?.say || !this.speak) return;
    this.talkInFlight = true;
    this.lastSpokeAt = Date.now();
    log(`agent: talk start id=${line.id || '?'} "${line.say.slice(0, 48)}" (${line.reason})`);
    try {
      await this.speak(line.say, line.reason, {
        chatId: line.chatId || null,
        gesture: line.gesture || null,
        gestureSet: line.gestureSet === true,
        expression: line.expression || null,
        priority: line.priority,
        id: line.id || null,
      });
    } catch (err) {
      log(`agent: talk failed: ${err.message}`);
    } finally {
      this.talkInFlight = false;
    }
  }

  // Brain writes the idle line when it is up, and the canned pool is only the
  // offline / network fallback. The compose is not awaited: play keeps its 1s tick.
  #queueIdle(game) {
    if (this.stopped || this.idleCompose) return;
    if (this.talkInFlight || this.talkQueue.some((q) => q.priority >= TALK_IDLE)) return;
    const canned = () => {
      const line = pickLine(this.#idlePool(), this.recentIdleLines);
      if (line) this.#enqueueTalk(line, 'ingame:vibes');
    };
    if (!this.brain || this.brain.offline || typeof this.brain.say !== 'function') {
      canned();
      return;
    }
    this.idleCompose = true;
    const segment = String(this.getSegment?.() || 'play');
    const table = tableName(game);
    const screen = this.#screenState();
    const payload = { segment, game: table };
    if (screen) payload.state = screen;
    Promise.resolve(this.brain.say('idle', payload))
      .then((shaped) => {
        this.idleCompose = false;
        if (this.stopped) return;
        if (!shaped || shaped.fallback || !shaped.text) {
          log('agent: idle canned (brain fallback)');
          canned();
          return;
        }
        const g = gestureFromCue(shaped.gesture);
        log(`agent: idle grounded "${String(shaped.text).slice(0, 48)}" expr=${shaped.emotion || '-'}`);
        this.#enqueueTalk(shaped.text, 'ingame:vibes', {
          expression: shaped.emotion || null,
          gesture: g.gesture,
          gestureSet: g.set,
        });
      })
      .catch((err) => {
        this.idleCompose = false;
        log(`agent: idle canned (${err?.message || 'brain'})`);
        if (!this.stopped) canned();
      });
  }

  // Soft segment bias for idle chatter: play gets hype, chill stays quiet, chatPick
  // invites the next game call. Default keeps the old hype/idle mix.
  #idlePool() {
    const segment = String(this.getSegment?.() || '').toLowerCase();
    if (segment === 'play') return Math.random() < 0.75 ? HYPE_LINES : IDLE_LINES;
    if (segment === 'chill') return Math.random() < 0.7 ? CHILL_LINES : IDLE_LINES;
    if (segment === 'chatpick') return Math.random() < 0.75 ? CHAT_PICK_LINES : IDLE_LINES;
    return Math.random() < 0.4 ? HYPE_LINES : IDLE_LINES;
  }

  // Never invent a round or a multiplier: only a safe idle line, and only when the feed
  // has actually produced frames.
  #fallback(obs) {
    const ready = !!obs?.game?.ready && !!obs?.game?.hasFrame;
    if (!ready) {
      return { action: 'silence', target: null, say: null, reason: 'fallback: game not ready' };
    }
    const g = obs?.game || {};
    const clickables = Array.isArray(g.clickables) ? g.clickables : [];
    // Lobby with no LLM JSON: open any Originals table so we do not sit mute on /casino.
    if (this.#inLobby(g)) {
      const labels = this.#shortGames(clickables);
      if (labels.length) {
        const pick = labels[Math.floor(Math.random() * labels.length)];
        return { action: 'click', target: pick, say: null, reason: `fallback:lobby→${pick}` };
      }
      const dest = originalsUrl('dice');
      if (dest) return { action: 'navigate', target: dest, say: null, reason: 'fallback:lobby→dice' };
    }
    const react = this.#outcomeLine(obs);
    if (react) return react;
    const since = this.lastSpokeAt || this.startedAt;
    if (Date.now() - since > this.idleSpeakMs) {
      this.#queueIdle(obs?.game);
      return { action: 'wait', target: null, say: null, reason: 'fallback: vibes idle' };
    }
    return { action: 'wait', target: null, say: null, reason: 'fallback: idle' };
  }

  // Demo-table colour: react once when the live marker result changes. The page text
  // path ("you win/you lose") stays as a fallback for games without the dice marker.
  // A measured result becomes a short grounded line. With no measurement, the local
  // pools speak. A brain round-trip would miss the 2s freshness gate, so it does not.
  #outcomeLine(obs) {
    const now = Date.now();
    const outcome = obs?.game?.outcome || this.game?.ui?.outcome || null;
    if (outcome && Number.isFinite(Number(outcome.result))) {
      const result = Number(outcome.result);
      // First sample is only a baseline - speaking on load would be a non-event.
      if (this.lastOutcomeResult === null || this.lastOutcomeResult === undefined) {
        this.lastOutcomeResult = result;
        return null;
      }
      if (result === this.lastOutcomeResult) return null;
      if (outcome.won !== true && outcome.won !== false) {
        this.lastOutcomeResult = result;
        return null;
      }
      // Do not advance lastOutcomeResult until we actually react - otherwise the
      // cooldown swallows the new result forever. 16s keeps outcome reacts from
      // talking on every single Bet.
      if (now - (this.lastReactAt || 0) < 16000) return null;
      const tag = outcome.won ? 'win' : 'lose';
      this.lastOutcomeResult = result;
      this.lastReactAt = now;
      this.#trackStreak(tag);
      // Long lose streak: say every other one. Updates above stop the tick from spamming.
      if (this.#skipStreakLose(tag)) return null;
      const line = this.#reactLine(tag);
      return { action: 'speak', target: null, say: line, reason: `react:${tag}`, eventAt: now };
    }
    const body = `${obs?.game?.bodySnippet || ''} ${obs?.game?.title || ''}`.toLowerCase();
    if (now - (this.lastReactAt || 0) < 12000) return null;
    let pool = null;
    let tag = '';
    if (/\b(you win|you won|winner|won \d|nice win|big win)\b/.test(body)) {
      pool = WIN_LINES; tag = 'win';
    } else if (/\b(you lose|you lost|bust|unlucky|better luck)\b/.test(body)) {
      pool = LOSE_LINES; tag = 'lose';
    }
    if (!pool) return null;
    if (this.lastReactTag === tag && now - (this.lastReactAt || 0) < 45000) return null;
    this.lastReactAt = now;
    this.#trackStreak(tag);
    if (this.#skipStreakLose(tag)) return null;
    const line = this.#reactLine(tag);
    return { action: 'speak', target: null, say: line, reason: `react:${tag}`, eventAt: now };
  }

  // Measured result/streak/multiplier when perception has them. Otherwise the
  // local win/lose pools, which is the pre-perception behaviour.
  #reactLine(tag) {
    try {
      const grounded = groundReaction({ tag, state: this.#screenState() });
      if (grounded) return grounded;
    } catch { /* scripted pool */ }
    const pool = tag === 'win' ? WIN_LINES : LOSE_LINES;
    return pickLine(pool, this.recentReactLines);
  }

  #screenState() {
    try {
      const state = this.perception?.state;
      if (!state?.ok) return null;
      return state;
    } catch {
      return null;
    }
  }

  #observedLobby() {
    try {
      if (!this.perception?.enabled) return [];
      const state = this.perception.state;
      if (!state?.ok || !Array.isArray(state.lobby)) return [];
      return state.lobby.filter(Boolean);
    } catch {
      return [];
    }
  }

  // Consecutive loses build a streak; any win resets it.
  #trackStreak(tag) {
    const prevTag = this.lastReactTag;
    this.lastReactTag = tag;
    if (tag === 'lose') {
      this.loseStreak = prevTag === 'lose' ? (this.loseStreak || 0) + 1 : 1;
    } else {
      this.loseStreak = 0;
    }
  }

  // Three loses in a row and the voice goes quiet on loses entirely; a win or a reset
  // ends the silence. Idle/hype lines and greetings still play, so the stream never dies.
  #skipStreakLose(tag) {
    return tag === 'lose' && this.loseStreak >= 3;
  }
}

function tableName(game) {
  const url = String(game?.url || '');
  const slug = url.match(/housegames-([a-z0-9-]+)/i);
  if (slug) return slug[1].replace(/-/g, ' ').slice(0, 40);
  const title = String(game?.title || '').replace(/\s+/g, ' ').trim();
  if (title && !/404|not found|housebets/i.test(title)) return title.slice(0, 40);
  return '';
}

function shortLabel(c) {
  const text = String(c?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > SHORT_LABEL) return null;
  return text;
}

// Canonical queue name -> regex fragment that also accepts the plural/spaced variants.
function gamePattern(game) {
  const g = String(game || '').trim().toLowerCase();
  if (!g) return null;
  if (g === 'mines') return 'mines?';
  if (g === 'blackjack') return 'black\\s*jack|blackjack';
  return g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDecision(text) {
  const s = String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeDecision(raw) {
  if (!raw || typeof raw !== 'object' || !ACTIONS.has(raw.action)) return null;
  let say = null;
  if (typeof raw.say === 'string' && raw.say.trim()) {
    say = sanitize(raw.say).trim() || null;
  }
  const target = typeof raw.target === 'string' && raw.target.trim()
    ? raw.target.trim().slice(0, 300)
    : null;
  const reason = typeof raw.reason === 'string'
    ? raw.reason.replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  return { action: raw.action, target, say, reason };
}
