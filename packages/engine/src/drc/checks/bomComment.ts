/**
 * DRC check: BOM Comment conflicts. JLCPCB flags a BOM where one LCSC part
 * number appears under different Comment strings (and the rows won't merge),
 * which happens when per-instance context is baked into `fields.value`
 * ("4.7k SDA" vs "4.7k SCL") instead of `fields.role`. One violation per
 * conflicting LCSC id, listing every distinct comment.
 *
 * The effective comment mirrors @flamingo/fab's bom.ts commentOf():
 * fields.value || fields.description || lcsc. Keep the two in sync.
 */
import type { Board, ComponentInst } from '../../types.js';
import type { RuleSet } from '../rules.js';
import type { DrcViolation } from '../types.js';

const LCSC_ID = /^C\d+$/i;

function commentOf(c: ComponentInst): string {
  return c.fields.value || c.fields.description || c.lcsc;
}

export function check(b: Board, _rules: RuleSet): DrcViolation[] {
  const byLcsc = new Map<string, ComponentInst[]>();
  for (const c of b.components) {
    if (!LCSC_ID.test(c.lcsc)) continue;
    const group = byLcsc.get(c.lcsc);
    if (group) group.push(c);
    else byLcsc.set(c.lcsc, [c]);
  }

  const violations: DrcViolation[] = [];
  for (const [lcsc, comps] of byLcsc) {
    const comments = new Set(comps.map(commentOf));
    if (comments.size < 2) continue;
    violations.push({
      rule: 'bom-comment-conflict',
      message:
        `${lcsc} appears in the BOM under ${comments.size} different Comments ` +
        `(${[...comments].map((s) => `"${s}"`).join(', ')}) — JLCPCB flags this. ` +
        `Use one bare value for all of them and move per-instance context into the role field.`,
      at: { x: comps[0].at.x, y: comps[0].at.y },
      items: comps.map((c) => c.refdes),
    });
  }
  return violations;
}
