import { BRIEF_CATALOG, type BriefId, type BriefSpec } from "../briefs/catalog.js";
import type { EditorTarget } from "../briefs/params.js";
import type { ContextSnapshot } from "./snapshot.js";

// Which briefs the panel can offer for the context it currently has, derived
// from the catalog rather than a hand-kept list: a brief added to BRIEF_CATALOG
// is offered here for free, and can never be labelled differently than it is in
// the sidebar or the editor menu.

export interface Offer {
  readonly briefId: BriefId;
  readonly label: string;
  readonly iconId: string;
  readonly command: string;
  /** Present only for briefs whose command accepts an EditorTarget. */
  readonly target?: EditorTarget;
}

function offerFor(spec: BriefSpec, snapshot: ContextSnapshot): Offer | undefined {
  const base = { briefId: spec.id, label: spec.label, iconId: spec.iconId, command: spec.command };
  switch (spec.context) {
    case "fileAndLine":
    case "file": {
      // Both take the same EditorTarget; a file-only brief simply ignores the
      // line. Offering either without a path would hand the command nothing it
      // could not already work out from the active editor itself.
      if (snapshot.path === undefined || snapshot.line === undefined) return undefined;
      return { ...base, target: { ref: snapshot.path, line: snapshot.line } };
    }
    case "none":
    case "prompted":
      // Prompted briefs ask for a resource ref or a ref plus namespace, neither
      // of which is an editor path. Pre-filling the branch is a PR 3 concern.
      return base;
    default: {
      // A new BriefContext member fails the build here rather than silently
      // dropping that brief out of the panel: this repo has no
      // noImplicitReturns, and the return type already admits undefined, so
      // without this the omission would compile clean.
      const exhaustive: never = spec.context;
      return exhaustive;
    }
  }
}

export function offersFor(snapshot: ContextSnapshot): Offer[] {
  const offers: Offer[] = [];
  for (const spec of BRIEF_CATALOG) {
    const offer = offerFor(spec, snapshot);
    if (offer !== undefined) offers.push(offer);
  }
  return offers;
}
