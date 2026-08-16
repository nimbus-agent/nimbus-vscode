// Trailing-edge debounce, one per event source.
//
// The tiers are the design spec's: a cursor moves constantly, an editor switch
// is rapid only while cycling tabs, and a language server re-lints in bursts
// that fire several events for one file.
export const DEBOUNCE_MS = { selection: 300, editor: 150, diagnostics: 500 } as const;

export interface Debouncer {
  trigger(): void;
  dispose(): void;
}

export function createDebouncer(delayMs: number, fn: () => void): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    trigger: () => {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, delayMs);
    },
    dispose: clear,
  };
}
