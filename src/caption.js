// Spoken subtitle under the avatar. It stays up while the line is playing and
// for a short hold after AudioBus reports playback end, then fades out.
export const CAPTION_HOLD_MS = 1500;
export const CAPTION_FADE_MS = 350;

// playbackEndedAt is null while the line is still playing (or has not started).
// Once the bus emits playback-end, the line holds, fades, then draws nothing.
export function captionStyle(caption, { playbackEndedAt = null, now = 0 } = {}) {
  const text = String(caption || '').trim();
  if (!text) return { text: '', alpha: 0 };
  if (playbackEndedAt == null) return { text, alpha: 1 };
  const age = now - playbackEndedAt;
  if (age < CAPTION_HOLD_MS) return { text, alpha: 1 };
  const fade = age - CAPTION_HOLD_MS;
  if (fade >= CAPTION_FADE_MS) return { text: '', alpha: 0 };
  return { text, alpha: 1 - fade / CAPTION_FADE_MS };
}
