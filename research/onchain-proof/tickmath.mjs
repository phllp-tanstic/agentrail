// tickmath.mjs - exact, float-free probability -> raw price conversion + tick snapping.
//
// THE BUG THIS EXISTS TO FIX
// -------------------------
// The naive path `parseUnits(price.toFixed(18), 18)` is WRONG on an 18-decimal
// chain. `Number.prototype.toFixed(18)` prints 18 decimal places, which is more
// precision than an IEEE-754 double actually carries, so it leaks the binary
// representation error of the decimal literal into digits 16-18:
//
//     (0.05).toFixed(18) === "0.050000000000000003"   // <-- not 0.05
//     (0.35).toFixed(18) === "0.349999999999999978"
//     (0.60).toFixed(18) === "0.599999999999999978"
//
// Somnia binary pools use tickSize = 1e15 raw units at 18 decimals (= 0.001
// probability). A raw price is on-tick only if it is a multiple of 1e15, i.e.
// only if its last 15 decimal digits are zero. The float garbage above lands
// squarely inside those 15 digits, so the resulting price is off-tick and the
// pool reverts PriceNotAlignedToTickSize() (0x961ac3e3).
//
// Only probabilities that are exactly representable in binary (0.25, 0.5,
// 0.75, ...) -- plus a minority whose error happens to round away at the 18th
// place -- survive.
//
// On TESTNET the collateral has 6 decimals, so parseUnits(..., 6) truncates the
// string at 6 fraction digits and throws the float garbage away before it can
// matter. Testnet therefore CANNOT reproduce this bug. That is why this module
// is unit-tested against mainnet's real 18-decimal parameters.

/**
 * Exact decimal-string -> raw BigInt at `decimals`, with no floating point.
 * Accepts a string, bigint, or number. For a number we use String(n) (the
 * shortest round-trip representation, e.g. "0.05") rather than toFixed(),
 * which is precisely what keeps the float error out.
 * Digits beyond `decimals` are rounded half-up.
 */
export function exactToRaw(value, decimals) {
  if (typeof value === 'bigint') return value;
  let s = typeof value === 'number' ? String(value) : String(value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s)) throw new Error(`exactToRaw: not a plain decimal: ${s}`);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let [int = '0', frac = ''] = s.split('.');
  if (int === '') int = '0';
  let out;
  if (frac.length <= decimals) {
    out = BigInt(int + frac.padEnd(decimals, '0'));
  } else {
    // round half-up on the first dropped digit
    const keep = frac.slice(0, decimals);
    const dropped = frac.slice(decimals);
    out = BigInt(int + keep);
    if (dropped[0] >= '5') out += 1n;
  }
  return neg ? -out : out;
}

/** The BROKEN path, reproduced verbatim so the test can prove it is broken. */
export function naiveRawPrice(prob, decimals) {
  // equivalent to viem parseUnits(prob.toFixed(18), decimals)
  return exactToRaw(Number(prob).toFixed(18), decimals);
}

/** True iff `raw` is an exact multiple of `tickSize`. */
export function isOnTick(raw, tickSize) {
  return BigInt(raw) % BigInt(tickSize) === 0n;
}

/**
 * Snap a probability to the nearest VALID on-chain tick.
 * @param prob      probability, e.g. 0.62 or "0.62" (0 < p < 1)
 * @param tickSize  raw tick size read from the pool (getBinaryBookParams)
 * @param decimals  collateral decimals (18 mainnet, 6 testnet)
 * @returns BigInt raw price, guaranteed a multiple of tickSize and within
 *          [tickSize, ONE - tickSize]
 */
export function snapPriceToTick(prob, tickSize, decimals) {
  const tick = BigInt(tickSize);
  if (tick <= 0n) throw new Error('tickSize must be > 0');
  const ONE = 10n ** BigInt(decimals);
  const raw = exactToRaw(prob, decimals);
  if (raw <= 0n || raw >= ONE) throw new Error(`probability out of range (0,1): ${prob}`);
  // round half-up to nearest tick multiple
  let n = (raw + tick / 2n) / tick;
  let snapped = n * tick;
  // clamp into the tradable interior
  if (snapped < tick) snapped = tick;
  if (snapped > ONE - tick) snapped = ONE - tick;
  return snapped;
}

/** Raw price -> human probability string (for logging). */
export function rawToProbString(raw, decimals) {
  const ONE = 10n ** BigInt(decimals);
  const r = BigInt(raw);
  const int = r / ONE;
  const frac = (r % ONE).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${int}.${frac}`;
}
