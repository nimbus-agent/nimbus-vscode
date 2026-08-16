import type { Logger } from "../logging.js";
import { errMsg } from "../logging.js";
import type { SidebarConnection } from "../sidebar/tree-view.js";
import { offersFor } from "./offers.js";
import type { ExtensionToContextView } from "./protocol.js";
import type { SignalDeps, SignalId, SignalSection, SignalSpec } from "./signals.js";
import type { ContextSnapshot } from "./snapshot.js";

// Everything that makes a Gateway-backed signal affordable: an LRU cache keyed
// by what each signal actually depends on, in-flight coalescing, a generation
// fence, and invalidation. Pure — no vscode, no timers. Debounce stays in the
// glue file, where the events are.
//
// SidebarConnection is reused rather than re-declared: it is the two-member
// slice (current + onState) every sidebar view already programs against, and
// the real ConnectionManager satisfies it structurally.

const DEFAULT_CACHE_LIMIT = 50;

export interface ControllerDeps {
  readonly signals: readonly SignalSpec[];
  readonly signalDeps: SignalDeps;
  readonly connection: SidebarConnection;
  readonly post: (message: ExtensionToContextView) => void;
  readonly isVisible: () => boolean;
  readonly log: Logger;
  readonly cacheLimit?: number;
}

export interface ContextController {
  collect(snapshot: ContextSnapshot): Promise<void>;
  /** Drop every cached entry whose key mentions this path — used on save. */
  invalidatePath(path: string): void;
  invalidateSignal(id: SignalId): void;
  invalidateAll(): void;
  dispose(): void;
}

export function createController(deps: ControllerDeps): ContextController {
  const limit = deps.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  // One cache per signal so a noisy signal cannot evict a quiet one.
  const caches = new Map<SignalId, Map<string, SignalSection>>();
  const inFlight = new Map<string, Promise<SignalSection>>();
  let generation = 0;
  let lastSnapshot: ContextSnapshot | undefined;

  const cacheFor = (id: SignalId): Map<string, SignalSection> => {
    const existing = caches.get(id);
    if (existing !== undefined) return existing;
    const fresh = new Map<string, SignalSection>();
    caches.set(id, fresh);
    return fresh;
  };

  const remember = (id: SignalId, key: string, section: SignalSection): void => {
    const cache = cacheFor(id);
    cache.delete(key);
    cache.set(key, section);
    // Insertion order is LRU order here: re-setting moves an entry to the end,
    // so the first key is always the least recently written.
    while (cache.size > limit) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  const disconnectedSection = (spec: SignalSpec): SignalSection => ({
    id: spec.id,
    title: titleOf(spec.id),
    rows: [],
    empty: "Needs the Nimbus Gateway.",
  });

  const loadingSection = (spec: SignalSpec): SignalSection => ({
    id: spec.id,
    title: titleOf(spec.id),
    rows: [],
    loading: true,
  });

  const runOne = async (
    spec: SignalSpec,
    snapshot: ContextSnapshot,
    mine: number,
  ): Promise<void> => {
    const key = spec.cacheKey(snapshot);
    const flightKey = `${spec.id}:${key ?? ""}`;
    try {
      let pending = key === undefined ? undefined : inFlight.get(flightKey);
      if (pending === undefined) {
        // Called INSIDE the try on purpose. A collector that throws
        // synchronously would otherwise escape before the cleanup below, so its
        // in-flight entry would survive forever and every later collection for
        // the same key would await a promise that can only reject.
        pending = spec.collect(snapshot, deps.signalDeps);
        if (key !== undefined) inFlight.set(flightKey, pending);
      }
      const section = await pending;
      // Only a successful section is worth remembering.
      if (key !== undefined) remember(spec.id, key, section);
      // The fence: a later snapshot has overtaken this one, so this answer is
      // about a line or file the user has already left.
      if (mine !== generation) return;
      deps.post({ type: "section", generation: mine, section });
    } catch (e: unknown) {
      deps.log.warn(`context signal ${spec.id} failed: ${errMsg(e)}`);
      // Never leave a section on "Loading…". The two collectors catch their own
      // RPC failures, but anything thrown outside that — or by a future signal
      // whose author forgets — would hang that section for the rest of the
      // session, with only a log line to explain it.
      if (mine === generation) {
        deps.post({
          type: "section",
          generation: mine,
          section: {
            id: spec.id,
            title: titleOf(spec.id),
            rows: [{ label: `Unavailable: ${errMsg(e)}`, iconId: "error" }],
          },
        });
      }
    } finally {
      if (key !== undefined) inFlight.delete(flightKey);
    }
  };

  const collect = async (snapshot: ContextSnapshot): Promise<void> => {
    if (!deps.isVisible()) return;
    generation += 1;
    const mine = generation;
    lastSnapshot = snapshot;
    const connected = deps.connection.current().kind === "connected";

    const initial: SignalSection[] = [];
    const toRun: SignalSpec[] = [];
    for (const spec of deps.signals) {
      if (spec.needsGateway && !connected) {
        initial.push(disconnectedSection(spec));
        continue;
      }
      const key = spec.cacheKey(snapshot);
      const cached = key === undefined ? undefined : cacheFor(spec.id).get(key);
      if (cached !== undefined) {
        initial.push(cached);
        continue;
      }
      initial.push(loadingSection(spec));
      toRun.push(spec);
    }

    deps.post({
      type: "render",
      generation: mine,
      sections: initial,
      offers: offersFor(snapshot),
      isDirty: snapshot.isDirty,
    });

    await Promise.all(toRun.map((spec) => runOne(spec, snapshot, mine)));
  };

  const refresh = (reason: string): void => {
    const snapshot = lastSnapshot;
    if (snapshot === undefined || !deps.isVisible()) return;
    void collect(snapshot).catch((e: unknown) => deps.log.warn(`context ${reason}: ${errMsg(e)}`));
  };

  const sub = deps.connection.onState((state) => {
    // Nothing cached survives a state change in either direction: the index can
    // change while we are away.
    caches.clear();
    // Both halves refresh, and for symmetrical reasons. Losing the Gateway must
    // replace stale blame and related answers with "Needs the Nimbus Gateway"
    // rather than leaving results on screen that read as current; regaining it
    // must fill them back in without waiting for the user to move the cursor.
    refresh(
      state.kind === "connected"
        ? "re-collect after reconnect failed"
        : "clear after disconnect failed",
    );
  });

  return {
    collect,
    invalidatePath: (path) => {
      for (const cache of caches.values()) {
        for (const key of [...cache.keys()]) if (key.includes(path)) cache.delete(key);
      }
    },
    invalidateSignal: (id) => cacheFor(id).clear(),
    invalidateAll: () => caches.clear(),
    dispose: () => {
      sub.dispose();
      caches.clear();
      inFlight.clear();
    },
  };
}

// The title a section carries before its collector has produced one.
function titleOf(id: SignalId): string {
  switch (id) {
    case "problems":
      return "Problems";
    case "git":
      return "Git";
    case "blame":
      return "History";
    case "related":
      return "Related";
  }
}
