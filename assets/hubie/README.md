# Hubie art / Art Hubie

The contest asks for **"animated Hubie, from official art"**. It does **not** publish a
downloadable art pack on the public rules page — the only instruction on `/contests` is the
generic "take the task, download the pack" line that also covers the design contest. So the
source of truth for how Hubie looks is the mascot art Housebets publishes itself.

Hubie is an anthropomorphic **sloth** in a white lab coat with cyan piping, navy top hat and
bowtie, goggles on the hat, headset with a mic boom, gold buttons.

## Fetch it

```bash
npm run art        # scripts/fetch-art.mjs
```

Downloads into this folder (git-ignored — this is Housebets' artwork, not something we
redistribute):

| File | Where it comes from |
| --- | --- |
| `labs.webp` | `hubie-labs` — **1000x1000 with alpha** (44% transparent); the renderer uses this one |
| `portrait.webp` | `hubie-welcome-portrait` — 192x192 opaque bust, fallback only |
| `hero.webp` | the contest hero image |
| `welcome-row.webp` | small portrait strip |
| `gamble-responsibly.webp` | the site's responsible-gambling graphic |

If Housebets adds a real art pack later, drop its transparent layers here and point
`rig.json` at them; the renderer prefers `portrait.*` and otherwise falls back to a drawn
stand-in.

## rig.json

```json
{
  "bob": 3,
  "sway": 2,
  "mouth": { "x": 0.43, "y": 0.425, "w": 0.17, "h": 0.045 },
  "eyes": { "x": 0.455, "y": 0.371, "w": 0.215, "h": 0.08 },
  "blinkMs": [2800, 5200],
  "blinkDurationMs": 120,
  "layers": {
    "mouthOpen": "layers/mouth_open.png",
    "mouthClosed": "layers/mouth_closed.png",
    "lidClosed": "layers/lid_closed.png"
  }
}
```

`bob` = idle vertical drift in pixels, `sway` = horizontal drift. `mouth` / `eyes` are
fractions of the drawn art box (the sloth face on `labs.webp`), used to place the overlays.
`blinkMs` is the random interval between blinks, `blinkDurationMs` the fade open→closed→open.

The character is drawn bottom-anchored at full alpha over the scene, with a soft shadow, a
warm glow while speaking, and a small voice meter. `labs.webp` is a bust, so there is no clean
jaw to puppet — the overlays below are subtle, not a full mouth replacement.

## layers/ — our overlays

These PNGs are **our own drawn shapes**, generated with `@napi-rs/canvas`, not cropped copies
of Housebets' art. They are committed.

| File | Use |
| --- | --- |
| `mouth_open.png` | soft dark ellipse / jaw shadow, drawn over the smirk while speaking |
| `mouth_closed.png` | thin closed line, faded in as the voice drops |
| `lid_closed.png` | two soft eyelids, drawn over the eye box during a blink |

Regenerate them with:

```bash
npm run layers        # scripts/make-layers.mjs
```

The renderer loads whatever exists: if a layer file is missing, it just skips that overlay and
keeps drawing the official art — no crash, no placeholder puppet.

## Animation / Voice

`render.js` reads the movement fields from `rig.json` with safe defaults: `bob` / `sway`
(idle drift), `breathAmp` (subtle breathing scale), `tiltDeg` (micro head tilt), `lookAmp`
(occasional face shift) and `speakBobBoost` (extra bounce + mouth-synced nod while talking).
Blinking uses `blinkMs`, with roughly one in four blinks returning as a double-blink.

The voice is still local piper with `TTS_VOICE` / `TTS_SPEAKER` (libritts speakers 0-903;
704 is the calm male default). `PiperVoice` now also passes `--length_scale`,
`--noise_scale`, `--noise_w` and `--sentence_silence` from `TTS_LENGTH_SCALE`,
`TTS_NOISE_SCALE`, `TTS_NOISE_W` and `TTS_SENTENCE_SILENCE` (defaults 1.08 / 0.75 / 0.85 /
0.32): slower phonemes, more variation and a longer sentence tail. A soft-knee limiter in
the PCM path rounds off peaks so loud syllables do not clip.

## Rights

The artwork belongs to Housebets. It is fetched at runtime for the contest entry and is not
committed, redistributed, or used as a template for other projects. Only `README.md`,
`rig.json` and `layers/*.png` (our own drawn overlays) are tracked; `*.webp` under this folder
stay git-ignored.
