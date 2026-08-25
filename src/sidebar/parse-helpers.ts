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

/**
 * The domain object a tree NODE carries on `payload`. VS Code hands a
 * view/item/context command the node element itself — not the row's
 * `command.arguments` — so every such handler starts by digging the payload out
 * of an `unknown`, and each one that open-codes it is a chance to forget the
 * null check (`typeof null === "object"`).
 */
export function nodePayload(node: unknown): unknown {
  return typeof node === "object" && node !== null
    ? (node as { payload?: unknown }).payload
    : undefined;
}

/**
 * Parse every row that parses and drop the rest. A malformed row from the
 * Gateway costs its own row, never the whole view — which is why this filters
 * rather than throwing.
 */
export function parseAll<T>(rows: readonly unknown[], parse: (row: unknown) => T | undefined): T[] {
  const parsed: T[] = [];
  for (const row of rows) {
    const one = parse(row);
    if (one !== undefined) parsed.push(one);
  }
  return parsed;
}
