/**
 * Flamingo Panel - fee table shape (`config/fee-table.json`).
 *
 * The cost model takes this table as an argument and holds no prices itself.
 */

import type { AssemblyType, Sourced } from './config.js';

export interface QtyPrice {
  qty: number;
  price: number;
}

export interface AreaTier {
  /** Upper bound of the tier in m2 of ordered board; null = no upper bound. */
  upToM2: number | null;
  perM2: number;
}

export interface JointTier {
  /** Upper bound of the tier in joints. */
  upTo: number;
  price: number;
}

export interface PerSide {
  single: number;
  /** null when the service does not place both sides. */
  double: number | null;
}

export interface AttritionRule {
  /** Applies to parts with at most this many joints; null = any. */
  maxJoints: number | null;
  /** Spare parts added to the quantity used. */
  extra: number;
  /** Least quantity billed for one line. */
  minimum: number;
  kind: string;
}

export interface AssemblyFees {
  setupFee: Sourced<PerSide>;
  stencil: Sourced<PerSide>;
  smtJoint: Sourced<JointTier[]>;
  feederLoading: Sourced<{ basic: number; extended: number }>;
  qtySteps: Sourced<number[]>;
}

type LayerKey = '2' | '4' | '6';

export interface FeeTable {
  currency: string;
  asOf: string;
  pcb: {
    qtySteps: Sourced<number[]>;
    promo: {
      maxSize: Sourced<{ width: number; height: number }>;
      prices: Record<LayerKey, Sourced<QtyPrice[]>>;
    };
    engineeringFee: Record<LayerKey, Sourced<number>>;
    areaRate: Record<LayerKey, Sourced<AreaTier[]>>;
    differentDesigns: {
      perExtraDesign: Sourced<number>;
      rule: Sourced<string>;
      maxDesigns: Sourced<number>;
    };
    smallBoardDeburring: Sourced<Array<{ underMm: number; perPiece: number }>>;
    /** V-cut surcharge for small boards: JLCPCB publishes no amount in text, so null. */
    vcutSmallBoard?: Sourced<number | null>;
  };
  assembly: Record<AssemblyType, AssemblyFees> & {
    manualJoint: Sourced<number>;
    handSolderLabor: Sourced<number>;
    panelFee: Sourced<number>;
    largePcb: Sourced<{ overCm2: number; fee: number }>;
  };
  parts: {
    attrition: Sourced<AttritionRule[]>;
  };
}

/** Smallest step that covers `n`; null when `n` is beyond the last step. */
export function stepAtLeast(steps: number[], n: number): number | null {
  for (const s of [...steps].sort((a, b) => a - b)) if (s >= n) return s;
  return null;
}
