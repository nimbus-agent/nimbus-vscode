import type { Logger } from "../logging.js";
import { errMsg } from "../logging.js";
import type { SidebarConnection } from "../sidebar/tree-view.js";
import { offersFor } from "./offers.js";
import type { ExtensionToContextView } from "./protocol.js";
import {
  NEEDS_GATEWAY,
  SECTION_TITLES,
  type SignalDeps,
  type SignalId,
  type SignalSection,
  type SignalSpec,
} from "./signals.js";
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
  /** Drop every cached entry collected while the editor was at this path. */
  invalidatePath(path: string): void;
  invalidateSignal(id: SignalId): void;
  invalidateAll(): void;
  dispose(): void;
}

// A cached section, tagged with the path of the snapshot it was collected
// for. The tag — not the cache key's own text — is what invalidatePath
// matches on: a signal's key (e.g. related's, which may be just the
// selected text) does not necessarily mention the path at all.
interface CacheEntry {
  readonly section: SignalSection;
  readonly path: string | undefined;
}

// An in-flight collection, tagged the same way for the same reason, plus the
// invalidation epoch it started under — see bumpEpoch below.
interface FlightEntry {
  readonly promise: Promise<SignalSection>;
  readonly path: string | undefined;
  readonly epoch: number;
}

export function createController(deps: ControllerDeps): ContextController {
  const limit = deps.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  // One cache — and one in-flight table — per signal, so a noisy signal can
  // neither evict a quiet one nor coalesce with it.
  const caches = new Map<SignalId, Map<string, CacheEntry>>();
  const inFlight = new Map<SignalId, Map<string, FlightEntry>>();
  let generation = 0;
  let lastSnapshot: ContextSnapshot | undefined;
  let disposed = false;
  // Bumped by every invalidation path (path/signal/all, and the connection
  // listener's clear). A runOne that started under an older epoch must not
  // let its eventual answer land in the cache: the invalidation happened for
  // a reason, and an in-flight promise that predates it does not know that.
  let epoch = 0;

  const cacheFor = (id: SignalId): Map<string, CacheEntry> => {
    const existing = caches.get(id);
    if (existing !== undefined) return existing;
    const fresh = new Map<string, CacheEntry>();
    caches.set(id, fresh);
    return fresh;
  };

  const flightFor = (id: SignalId): Map<string, FlightEntry> => {
    const existing = inFlight.get(id);
    if (existing !== undefined) return existing;
    const fresh = new Map<string, FlightEntry>();
    inFlight.set(id, fresh);
    return fresh;
  };

  const remember = (id: SignalId, key: string, entry: CacheEntry): void => {
    const cache = cacheFor(id);
    cache.delete(key);
    cache.set(key, entry);
    // Insertion order is LRU order here: re-setting moves an entry to the end,
    // so the first key is always the least recently written.
    while (cache.size > limit) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  // Bumps the epoch and drops every entry `matches` accepts, from both the
  // cache and the in-flight table. Dropping from `inFlight` alone would not
  // be enough: a promise already captured by a `runOne` that is mid-await
  // survives the drop and would otherwise still call `remember` when it
  // resolves — the epoch check in `runOne` is what catches that case.
  const invalidateWhere = (matches: (path: string | undefined) => boolean): void => {
    epoch += 1;
    for (const cache of caches.values()) {
      for (const [key, entry] of [...cache.entries()]) {
        if (matches(entry.path)) cache.delete(key);
      }
    }
    for (const flight of inFlight.values()) {
      for (const [key, entry] of [...flight.entries()]) {
        if (matches(entry.path)) flight.delete(key);
      }
    }
  };

  const disconnectedSection = (spec: SignalSpec): SignalSection => ({
    id: spec.id,
    title: SECTION_TITLES[spec.id],
    rows: [],
    empty: NEEDS_GATEWAY,
  });

  const loadingSection = (spec: SignalSpec): SignalSection => ({
    id: spec.id,
    title: SECTION_TITLES[spec.id],
    rows: [],
    loading: true,
  });

  const post = (message: ExtensionToContextView): void => {
    // Nothing should reach a torn-down view: dispose() does not touch
    // `generation`, so the ordinary fence below cannot catch this on its own.
    if (disposed) return;
    deps.post(message);
  };

  const runOne = async (
    spec: SignalSpec,
    snapshot: ContextSnapshot,
    mine: number,
  ): Promise<void> => {
    const key = spec.cacheKey(snapshot);
    const path = snapshot.path;
    const epochAtStart = epoch;
    // Hoisted above the try so the `finally` below can identify — and only
    // remove — the in-flight entry THIS call created or reused.
    let pending: Promise<SignalSection> | undefined;
    try {
      if (key !== undefined) {
        const existing = flightFor(spec.id).get(key);
        // Only reuse an entry from the CURRENT epoch. One that predates an
        // invalidation is normally already gone (invalidateWhere deletes
        // matching entries), but this is the belt to that suspenders.
        if (existing !== undefined && existing.epoch === epoch) pending = existing.promise;
      }
      if (pending === undefined) {
        // Called INSIDE the try on purpose. A collector that throws
        // synchronously would otherwise escape before the cleanup below, so its
        // in-flight entry would survive forever and every later collection for
        // the same key would await a promise that can only reject.
        pending = spec.collect(snapshot, deps.signalDeps);
        if (key !== undefined) flightFor(spec.id).set(key, { promise: pending, path, epoch });
      }
      const section = await pending;
      // Worth remembering only if nothing invalidated this key while the
      // collection was in flight, and the answer is not a transient error a
      // collector recovered from — the two Gateway collectors resolve rather
      // than reject on a dropped RPC, so a caught hiccup must not pin itself
      // into the cache as if it were a real answer.
      if (key !== undefined && epoch === epochAtStart && section.transient !== true) {
        remember(spec.id, key, { section, path });
      }
      // The fence: a later snapshot has overtaken this one, so this answer is
      // about a line or file the user has already left.
      if (mine !== generation) return;
      post({ type: "section", generation: mine, section });
    } catch (e: unknown) {
      deps.log.warn(`context signal ${spec.id} failed: ${errMsg(e)}`);
      // Never leave a section on "Loading…". The two collectors catch their own
      // RPC failures, but anything thrown outside that — or by a future signal
      // whose author forgets — would hang that section for the rest of the
      // session, with only a log line to explain it.
      if (mine === generation) {
        post({
          type: "section",
          generation: mine,
          section: {
            id: spec.id,
            title: SECTION_TITLES[spec.id],
            rows: [{ label: `Unavailable: ${errMsg(e)}`, iconId: "error" }],
            transient: true,
          },
        });
      }
    } finally {
      if (key !== undefined) {
        const current = flightFor(spec.id).get(key);
        // Only delete OUR entry: a newer runOne may already have replaced it
        // (e.g. an invalidation removed this one and a fresh collection is
        // already running), and this cleanup must not clobber that one.
        if (current !== undefined && current.promise === pending) flightFor(spec.id).delete(key);
      }
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
        initial.push(cached.section);
        continue;
      }
      initial.push(loadingSection(spec));
      toRun.push(spec);
    }

    post({
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
    // Nothing cached survives a state change in either direction: the index
    // can change while we are away, and this counts as an invalidation too —
    // an in-flight answer from before the state flipped must not land in a
    // cache that has just been declared stale.
    invalidateWhere(() => true);
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
    invalidatePath: (path) => invalidateWhere((p) => p === path),
    invalidateSignal: (id) => {
      epoch += 1;
      cacheFor(id).clear();
      flightFor(id).clear();
    },
    invalidateAll: () => invalidateWhere(() => true),
    dispose: () => {
      disposed = true;
      sub.dispose();
      caches.clear();
      inFlight.clear();
    },
  };
}
