// Stake lock. Hubie may click Bet / Roll, but the amount written into a stake field is
// always the configured stake and nothing else. Default 0 = pure demo. Set BET_STAKE to
// the table minimum to play real demo-balance rounds; the guard still refuses anything
// the operator did not configure.

const configured = Number(String(process.env.BET_STAKE ?? '').trim());
export const DEMO_STAKE = Number.isFinite(configured) && configured > 0 ? configured : 0;

const STAKE_LABEL = /bet|amount|wager|stake/i;

export function isStakeField(label) {
  return STAKE_LABEL.test(String(label || ''));
}

// Anything other than exactly 0 is rejected. The returned stake is still 0 so a
// caller can keep the demo loop running without ever typing a real amount.
// Null, empty, and non-numeric values are rejected too: only an explicit zero passes.
export function guardBetAmount(value) {
  if (typeof value === 'number') {
    if (value === DEMO_STAKE) return { ok: true, stake: DEMO_STAKE, rejected: null };
    return { ok: false, stake: DEMO_STAKE, rejected: value };
  }
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text || !/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    return { ok: false, stake: DEMO_STAKE, rejected: value ?? null };
  }
  const raw = Number(text);
  if (Math.abs(raw - DEMO_STAKE) < 1e-12) return { ok: true, stake: DEMO_STAKE, rejected: null };
  return { ok: false, stake: DEMO_STAKE, rejected: value ?? null };
}

// The only string ensureBetZero is allowed to type into a bet field.
export function demoStakeString() {
  const guarded = guardBetAmount(DEMO_STAKE);
  if (!guarded.ok) throw new Error('bet guard failed');
  // Integers stay integers; small crypto stakes need their decimals intact.
  return Number.isInteger(DEMO_STAKE) ? String(DEMO_STAKE) : String(DEMO_STAKE);
}
