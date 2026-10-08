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
