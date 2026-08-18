/** `MIN_SYNC_INTERVAL_MS` as documented on ConnectorSetConfigParams. */
export const MIN_INTERVAL_MS = 60_000;

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const PATTERN = /^(\d+)\s*([smhd])$/i;

// Validating the floor here rather than letting the Gateway reject it keeps the
// feedback in the input box, where the user still has the value in hand.
export function parseInterval(input: string): { ms: number } | { error: string } {
  const match = PATTERN.exec(input.trim());
  if (match === null) return { error: "Use a duration like 15m, 2h or 1d." };
  const [, digits, unit] = match;
  if (unit === undefined) return { error: "Use a duration like 15m, 2h or 1d." };
  const unitKey = unit.toLowerCase() as keyof typeof UNITS;
  const ms = Number(digits) * UNITS[unitKey];
  if (ms < MIN_INTERVAL_MS) return { error: "The Gateway enforces a minimum of 60s." };
  return { ms };
}

export function formatInterval(ms: number): string {
  if (ms % UNITS.d === 0) return `${ms / UNITS.d}d`;
  if (ms % UNITS.h === 0) return `${ms / UNITS.h}h`;
  if (ms % UNITS.m === 0) return `${ms / UNITS.m}m`;
  return `${Math.round(ms / UNITS.s)}s`;
}
