/**
 * Flamingo Fab - Excellon drill files (M48 / METRIC).
 *
 * Two files: plated (`-PTH.DRL`) and non-plated (`-NPTH.DRL`). Plated holes are
 * vias, plated through-hole pad drills, and plated mounting holes; non-plated
 * are unplated mounting holes and unplated pad drills. Slotted pad drills
 * (`drill.slotLength`) are emitted as routed slots (G85) along the pad's rotated
 * long axis; the two G85 endpoints are the slot centerline ends, separated by
 * (slotLength - diameter) so the swept width equals `diameter`.
 *
 * Coordinates are decimal millimetres (KiCad-style), which the tracespace drill
 * parser reads directly. Tools are deduped by diameter to 3 decimal places.
 */

import type { Board, Pad, Point } from '@flamingo/engine';
import { padWorld, rotate } from '@flamingo/engine';

interface DrillHole {
  diameter: number;
  at: Point;
  slot?: { start: Point; end: Point };
}

export interface Drills {
  plated: string | null;
  unplated: string | null;
}

function xy(n: number): string {
  const s = n.toFixed(3);
  return s === '-0.000' ? '0.000' : s;
}

function tool(d: number): string {
  return d.toFixed(3);
}

/** Compute a slot pad's centerline endpoints in world space. */
function slotEndpoints(pad: Pad, world: { at: Point; rotation: number }): { start: Point; end: Point } {
  const diameter = pad.drill!.diameter;
  const slotLength = pad.drill!.slotLength!;
  const half = Math.max(0, (slotLength - diameter) / 2);
  // Long axis in pad-local space, then rotated into world.
  const local: Point = pad.size.w >= pad.size.h ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const dir = rotate(local, world.rotation);
  return {
    start: { x: world.at.x - dir.x * half, y: world.at.y - dir.y * half },
    end: { x: world.at.x + dir.x * half, y: world.at.y + dir.y * half },
  };
}

function collectHoles(b: Board): { plated: DrillHole[]; unplated: DrillHole[] } {
  const plated: DrillHole[] = [];
  const unplated: DrillHole[] = [];

  for (const v of b.vias) {
    plated.push({ diameter: v.drill, at: v.at });
  }

  for (const comp of b.components) {
    for (const pad of comp.footprint.pads) {
      if (!pad.drill) continue;
      const world = padWorld(comp, pad);
      const isSlot = pad.drill.slotLength !== undefined && pad.drill.slotLength > pad.drill.diameter;
      const hole: DrillHole = isSlot
        ? { diameter: pad.drill.diameter, at: world.at, slot: slotEndpoints(pad, world) }
        : { diameter: pad.drill.diameter, at: world.at };
      (pad.drill.plated ? plated : unplated).push(hole);
    }
  }

  for (const h of b.holes) {
    (h.plated ? plated : unplated).push({ diameter: h.drill, at: h.at });
  }

  return { plated, unplated };
}

function drillFile(holes: DrillHole[], plated: boolean): string | null {
  if (holes.length === 0) return null;

  // Dedupe tools by diameter (3dp), assign T1..Tn in ascending diameter order.
  const byTool = new Map<string, number>();
  const diameters = Array.from(new Set(holes.map((h) => tool(h.diameter)))).sort(
    (a, b) => parseFloat(a) - parseFloat(b),
  );
  diameters.forEach((d, i) => byTool.set(d, i + 1));

  const lines: string[] = [
    'M48',
    ';GENERATION_SOFTWARE,CW&T,Flamingo,0.1',
    `;TYPE=${plated ? 'PLATED' : 'NON_PLATED'}`,
    'FMAT,2',
    'METRIC',
  ];
  for (const d of diameters) lines.push(`T${byTool.get(d)}C${d}`);
  lines.push('%', 'G90', 'G05');

  for (const d of diameters) {
    const t = byTool.get(d)!;
    lines.push(`T${t}`);
    for (const h of holes) {
      if (tool(h.diameter) !== d) continue;
      if (h.slot) {
        lines.push(`X${xy(h.slot.start.x)}Y${xy(h.slot.start.y)}G85X${xy(h.slot.end.x)}Y${xy(h.slot.end.y)}`);
      } else {
        lines.push(`X${xy(h.at.x)}Y${xy(h.at.y)}`);
      }
    }
  }

  lines.push('M30');
  return lines.join('\n') + '\n';
}

/** Build the plated + non-plated Excellon drill files (null when empty). */
export function buildDrills(b: Board): Drills {
  const { plated, unplated } = collectHoles(b);
  return {
    plated: drillFile(plated, true),
    unplated: drillFile(unplated, false),
  };
}
