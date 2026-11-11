/**
 * Flamingo Panel - which DRC ruleset a panel is made to.
 *
 * Each layer count has a standard JLCPCB ruleset and may have looser tiers
 * (`jlcpcb-4l-adv`: smaller vias, at extra cost). The panel takes the first
 * ruleset for its layer count that allows everything every board on it was
 * designed to, so a 4l-adv board keeps its small vias on a 4-layer panel and
 * an all-standard panel never pays for the advanced tier.
 */

import type { RuleSet } from '@flamingo/engine';
import { RULESETS } from '@flamingo/engine';
import type { ResolvedSources } from './resolved.js';

/** Rulesets per layer count, standard first, looser tiers after. */
const BY_LAYERS: Record<2 | 4 | 6, Array<RuleSet['id']>> = {
  2: ['jlcpcb-2l'],
  4: ['jlcpcb-4l', 'jlcpcb-4l-adv'],
  6: ['jlcpcb-6l'],
};

const NUMERIC = (Object.keys(RULESETS['jlcpcb-2l']) as Array<keyof RuleSet>).filter(
  (k) => typeof RULESETS['jlcpcb-2l'][k] === 'number',
);

/** The limits that `own` sets smaller than `panel` allows. */
export function tighterLimits(own: RuleSet, panel: RuleSet): Array<keyof RuleSet> {
  return NUMERIC.filter((k) => (own[k] as number) < (panel[k] as number) - 1e-9);
}

/**
 * The ruleset for a panel of `layers` layers carrying `sources`: the first one
 * for that layer count that is at least as permissive as every source's own.
 * When none is, the standard one, which `checkPanel` then reports against.
 * Sources with no geometry or an unknown ruleset are skipped here; the check
 * reports them on their own.
 */
export function panelRules(layers: 2 | 4 | 6, sources: ResolvedSources): RuleSet {
  const own = sources
    .map((s) => (s.geometry ? RULESETS[s.geometry.rules] : undefined))
    .filter((r): r is RuleSet => r !== undefined);
  const ids = BY_LAYERS[layers];
  for (const id of ids) {
    const candidate = RULESETS[id];
    if (own.every((r) => tighterLimits(r, candidate).length === 0)) return candidate;
  }
  return RULESETS[ids[0]!];
}
