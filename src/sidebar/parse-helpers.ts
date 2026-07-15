// Shared, dependency-free coercion helpers for defensively parsing unknown
// Gateway payloads into typed sidebar rows. Kept `vscode`-free like the pure
// parse modules that use them (audit.ts, egress.ts, index.ts, …).

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
