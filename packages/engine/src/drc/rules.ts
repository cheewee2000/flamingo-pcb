/**
 * Flamingo Engine - DRC Rule Sets
 * Units: mm
 *
 * One RuleSet per fab capability tier, keyed by `Board.rules`. Values are
 * encoded from https://jlcpcb.com/capabilities/pcb-capabilities as of plan
 * time (controller-approved for this task; not re-verified via WebFetch —
 * if these are ever suspected stale, re-check that page and update here).
 */

/**
 * Tolerance (mm) applied to every DRC threshold comparison: a measurement is
 * only a violation when it falls short by more than this much. Absorbs
 * float noise and tessellation quantization — e.g. a zone fill's inset band
 * built from 16-segment disks has a chord error of ≈6µm at r=0.3mm, which
 * can otherwise land geometry that is exactly at a rule minimum a few µm
 * under it. 10µm is an order of magnitude below typical fab process
 * tolerance, so it can't mask a real manufacturability problem.
 */
export const DRC_EPSILON = 0.01;

export interface RuleSet {
  id: 'jlcpcb-2l' | 'jlcpcb-4l' | 'jlcpcb-6l';
  minTrackWidth: number;
  minClearance: number;
  minDrill: number;
  minViaDiameter: number;
  minAnnular: number;
  copperToEdge: number;
  holeToHole: number;
  minSilkWidth: number;
}

export const RULESETS: Record<RuleSet['id'], RuleSet> = {
  'jlcpcb-2l': {
    id: 'jlcpcb-2l',
    minTrackWidth: 0.127,
    minClearance: 0.127,
    minDrill: 0.3,
    minViaDiameter: 0.5,
    minAnnular: 0.13,
    copperToEdge: 0.3,
    holeToHole: 0.5,
    minSilkWidth: 0.15,
  },
  'jlcpcb-4l': {
    id: 'jlcpcb-4l',
    minTrackWidth: 0.09,
    minClearance: 0.09,
    minDrill: 0.2,
    minViaDiameter: 0.45,
    minAnnular: 0.13,
    copperToEdge: 0.3,
    holeToHole: 0.5,
    minSilkWidth: 0.15,
  },
  'jlcpcb-6l': {
    id: 'jlcpcb-6l',
    minTrackWidth: 0.09,
    minClearance: 0.09,
    minDrill: 0.2,
    minViaDiameter: 0.45,
    minAnnular: 0.13,
    copperToEdge: 0.3,
    holeToHole: 0.5,
    minSilkWidth: 0.15,
  },
};
