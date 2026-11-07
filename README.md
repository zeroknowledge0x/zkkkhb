# Hubie — an AI host that plays and streams, live 24/7

Hubie is a self-hosted AI streamer: it watches a real casino game table through a headless
browser, reacts to what actually happens on that table, talks to chat out loud, and
renders the whole broadcast itself on a 1280×720 canvas that is pushed to RTMP.

Contest entry for **Housebets Contest Labs — Hubie, live 24/7**. Demo play only: the
stake lock keeps the bet at zero, so nothing on stream touches real money.

## How a round works

```
Chrome (CDP)  →  capture pump  →  perception (DOM)  →  brain (LLM)  →  voice (TTS)
                      │                                                   │
                      └─────────────► renderer (canvas) ◄─────────────────┘
                                              │
                                         ffmpeg → RTMP → Kick
```

| Stage | File | What it does |
| --- | --- | --- |
| Browser | `src/browser.js` | Launches Chrome with a persistent profile, CDP on 9222 |
| Capture | `src/game.js` | `Page.captureScreenshot` pump (~7 fps), table navigation by lobby card, click/read helpers, result markers |
| Perception | `src/perceive.js` | Turns the table DOM into `{ game, balance, multiplier, lastResult, round }` |
| Brain | `src/brain.js` | Reply, game choice and operator decisions; JSON-only operator channel |
| Voice | `src/tts-xai.js`, `src/tts.js` | xAI / Edge TTS with prosody shaping, numbers spoken as words |
| Render | `src/render.js` | Broadcast package: glass panels, chips, round history, lower-third caption, reaction FX |
| Output | `src/output.js` | ffmpeg → RTMP, with a local recording |
| Chat | `src/chat.js`, `src/chat-reply.js` | Kick chat ingest and reply priority |
| Ops | `scripts/telegram-bot.mjs` | Telegram control: status, frame, log, start/stop/restart, speak |

The host only speaks about things it can see: perception supplies the round result, and
the renderer draws the same numbers the viewer sees.

## Setup on a fresh machine

Three things deliberately do **not** live in git, because they are machine-bound or secret:
the API/stream keys, the browser profile that holds the table login, and the local TTS
binaries. Everything else is in this repository.

```bash
git clone https://github.com/zeroknowledge0x/zkkkhb
cd zkkkhb
npm install
npm run setup          # tells you exactly what is still missing
```

`npm run setup` checks Node, dependencies, the browser, ffmpeg, `.env` keys, the login
profile and the TTS assets for your chosen engine. It exits non-zero while anything is a
blocker, and prints the fix next to each one. Add `-- --probe` to also check that the game
lobby is reachable from this machine's egress country.

| Missing piece | How to provide it |
| --- | --- |
| `.env` | `cp .env.example .env`, then fill `STREAM_KEY`, `LLM_API_KEY`, and `XAI_API_KEY` when `TTS_ENGINE=xai` |
| table login | Copy `data/chrome-profile` from the streaming box, or run `start-hubie-headed.bat` once, log in, and keep the profile |
| local TTS | Only for `TTS_ENGINE=piper` or `kokoro`: `npm run bootstrap` fetches `vendor/` |
| ffmpeg | Install it and put it on `PATH` (or set `FFMPEG_PATH`) |

A logged-out profile and a blocked egress country are the two failures that look like code
bugs but are not: the first shows the lobby in a logged-out state, the second returns a
Cloudflare challenge instead of the table. `npm run setup -- --probe` distinguishes them.

Then:

```bash
npm run start          # headless, streams to the configured RTMP target
npm test               # 45 offline tests, no browser needed
```

## Quick start

```bash
npm install
cp .env.example .env      # then fill the keys you use
npm run doctor            # checks Chrome, ffmpeg, TTS, RTMP target
npm run start             # headless
```

Windows one-shot launcher: `start-hubie-headed.bat` (visible Chrome for login).

`npm run bootstrap` fetches ffmpeg/voice assets into `vendor/` (not committed — it is
hundreds of megabytes of binaries).

## Configuration

Everything is environment-driven; `.env.example` lists the keys with a comment each. The
ones that matter most:

| Key | Meaning |
| --- | --- |
| `KICK_CHANNEL`, `RTMP_URL`, `STREAM_KEY` | where the stream goes |
| `LLM_MODEL`, `LLM_API_KEY` | the brain |
| `TTS_ENGINE`, `XAI_VOICE` | the voice |
| `HOUSEBETS_URL` | table lobby the agent plays on |
| `BET_STAKE` | the only stake the guard will ever type; `0` = demo |
| `PLAYABLE_GAMES` | tables proven to resolve a round; everything else is declined |
| `CAPTURE_MODE` | `screencast` (CDP pump) or `desktop` (fallback) |
| `TELEGRAM_BOT_TOKEN` | optional operator bot |

## Tests

```bash
npm test
```

The suite covers perception parsing (balance, round results), voice shaping (numbers,
currency, speech tags), the bet guard, and the agent loop's decision paths. It runs
offline — no browser, no network.

## Layout

```
src/        the runtime (browser, capture, perception, brain, voice, render, output)
scripts/    operational tooling: restart/stop, Telegram bot, bootstrap, doctor
test/       offline unit tests
assets/     host artwork and rig
```

## Safety

- Stake is locked by `src/bet-guard.js`; a caller that asks for any other amount is
  refused, and the agent never types a number into a stake field.
- The overlay states *demo play, no real money*; the stream is 18+ and carries a
  responsible-gambling line.
- `PLAYABLE_GAMES` refuses tables that cannot finish a round, so the broadcast never
  shows a dead table.
