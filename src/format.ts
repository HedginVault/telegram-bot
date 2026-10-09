/** Formats a base-unit integer string as a display amount without going through `number`. */
export function formatBaseUnits(amountBaseUnits: string, decimals: number): string {
  const value = BigInt(amountBaseUnits);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${wholeText}.${fraction}` : wholeText;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

const withCommas = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Display trim of a plain decimal string ("1234.56789", "-0.000051673"): at most 4 fraction
 * digits when the whole part is non-zero, else 4 significant digits after the leading zeros.
 * Truncates, never rounds. Anything else (exponent notation, garbage) comes back unchanged.
 */
export function compactDecimal(decimal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) return decimal;
  const [, sign = "", wholeDigits = "0", fraction = ""] = match;
  const whole = wholeDigits.replace(/^0+(?=\d)/, "");
  let kept: string;
  if (whole !== "0") kept = fraction.slice(0, 4);
  else {
    const firstSignificant = fraction.search(/[1-9]/);
    if (firstSignificant === -1) return "0";
    kept = fraction.slice(0, firstSignificant + 4);
  }
  kept = kept.replace(/0+$/, "");
  return `${sign}${withCommas(whole)}${kept ? `.${kept}` : ""}`;
}

/** Short display amount for lists; `formatBaseUnits` stays the exact form for confirm screens. */
export function compactUnits(baseUnits: string, decimals: number): string {
  const value = BigInt(baseUnits);
  const abs = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const fraction = decimals > 0 ? `.${(abs % scale).toString().padStart(decimals, "0")}` : "";
  return compactDecimal(`${value < 0n ? "-" : ""}${abs / scale}${fraction}`);
}

const USD_UNITS = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
] as const;

/** "$1.25M", "$340K", "$12.50". Display only: USD values already arrive as floats from the API. */
export function compactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  for (const [unit, suffix] of USD_UNITS) {
    if (abs < unit) continue;
    const scaled = abs / unit;
    return `${sign}$${Number(scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2))}${suffix}`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}

/** Fee percent as the pool reports it: 0.2 → "0.2%", 0.04 → "0.04%". */
export const feePct = (percent: number) => `${percent.toFixed(4).replace(/\.?0+$/, "")}%`;
