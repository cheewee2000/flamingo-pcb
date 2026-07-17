/**
 * DRC check: keepout violations. Copper keepouts flag any copper item
 * polygon intersecting the keepout polygon on an affected layer. Via
 * keepouts flag any via whose center lies inside the keepout polygon, on
 * any keepout that touches a copper layer (since a via spans every copper
 * layer regardless of which specific layers the keepout names).
 */
import type { Board, Point } from '../../types.js';
import { copperLayersOf, isCopper } from '../../layers.js';
import { pointInPolygon, polyIntersects, polyGroupIntersects } from '../../geometry.js';
import type { RuleSet } from '../rules.js';
import type { CopperItem, DrcViolation } from '../types.js';

function centroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

export function check(b: Board, rules: RuleSet, items: CopperItem[]): DrcViolation[] {
  const violations: DrcViolation[] = [];

  for (const k of b.keepouts) {
    const layers = k.layers;

    if (k.keepout.copper) {
      for (const item of items) {
        if (layers !== 'all' && !layers.includes(item.layer)) continue;
        // Zone items honor holes: copper inside a knockout is absence-of-copper.
        const hit = item.group
          ? polyGroupIntersects(k.polygon, item.group)
          : polyIntersects(item.polygon, k.polygon);
        if (hit) {
          violations.push({
            rule: 'keepout',
            message: `${item.kind} ${item.ref} (net "${item.net}") on ${item.layer} intersects copper keepout ${k.id}`,
            at: centroid(item.polygon),
            items: [item.ref, k.id],
          });
        }
      }
    }

    if (k.keepout.via) {
      const affectsCopper = layers === 'all' || layers.some((l) => isCopper(l) && copperLayersOf(b).includes(l));
      if (affectsCopper) {
        for (const v of b.vias) {
          if (pointInPolygon(v.at, k.polygon)) {
            violations.push({
              rule: 'keepout',
              message: `Via ${v.id} (net "${v.net}") center lies inside via keepout ${k.id}`,
              at: v.at,
              items: [v.id, k.id],
            });
          }
        }
      }
    }
  }

  return violations;
}
