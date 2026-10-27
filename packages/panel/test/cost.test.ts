import { describe, it, expect } from 'vitest';
import { listSourced } from '../src/config.js';
import { billedQuantity, boardPrice, computeCost, tierPrice } from '../src/cost.js';
import type { CostBreakdown, CostCode, OrderConfig, OrderPart } from '../src/cost.js';
import { computeGeometry } from '../src/geometry.js';
import { arrange } from '../src/layout.js';
import { assemblyEligibility, pieceParts, quantitiesFor, quotePanel, receivedFor } from '../src/order.js';
import { FEES, LIMITS, applyAll, panelOf, plainBoard, resolved } from './helpers.js';
import type { Panel } from '../src/types.js';
import type { ResolvedSource } from '../src/resolved.js';

const R10K: OrderPart = { lcsc: 'C25804', basic: true, perPiece: 4, smtJoints: 2, thtJoints: 0, unitPrice: 0.001, value: '10k' };
const MCU: OrderPart = { lcsc: 'C2913204', basic: false, perPiece: 1, smtJoints: 41, thtJoints: 0, unitPrice: 3.2, value: 'ESP32' };
const HEADER: OrderPart = { lcsc: 'C124378', basic: false, perPiece: 1, smtJoints: 0, thtJoints: 8, unitPrice: 0.12, value: 'HDR' };

function order(extra: Partial<OrderConfig> = {}): OrderConfig {
  return {
    label: 'test',
    piece: { width: 40, height: 30, layers: 2, boards: 1, designs: 1, separation: 'none' },
    pcbQty: 5,
    ...extra,
  };
}

function line(c: CostBreakdown, code: CostCode) {
  const hit = c.lines.find((l) => l.code === code);
  if (!hit) throw new Error(`no ${code} line in [${c.lines.map((l) => l.code).join(', ')}]`);
  return hit;
}

describe('fee table', () => {
  it('gives every value a source and a verified flag', () => {
    const entries = [...listSourced(FEES), ...listSourced(LIMITS)];
    expect(entries.length).toBeGreaterThan(50);
    for (const { path, entry } of entries) {
      expect(typeof entry.verified, path).toBe('boolean');
      expect(entry.source, path).toMatch(/^(https:\/\/\S+|design-choice)$/);
      // Verified means read from a JLCPCB help article on a recorded date.
      if (entry.verified) {
        expect(entry.source, path).toMatch(/^https:\/\/jlcpcb\.com\/help\//);
        expect(entry.date, path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('marks every bare-board price as an estimate', () => {
    for (const { path, entry } of listSourced(FEES.pcb)) {
      if (/promo|engineeringFee|areaRate|perExtraDesign|qtySteps/.test(path)) expect(entry.verified, path).toBe(false);
    }
  });
});

describe('computeCost: bare boards', () => {
  it('uses the special offer for small boards', () => {
    const c = computeCost(order(), FEES);
    expect(c.lines).toHaveLength(1);
    expect(line(c, 'pcb')).toMatchObject({ amount: 2, estimate: true });
    expect(line(c, 'pcb').detail).toContain('special offer');
    expect(c.total).toBe(2);
    expect(c.estimate).toBe(true);
    expect(c.problems).toEqual([]);
  });

  it('prices by area beyond the special offer', () => {
    const piece = { width: 150, height: 100, layers: 2 as const, boards: 1, designs: 1, separation: 'none' as const };
    // 5 x 0.015 m2 = 0.075 m2 at 45/m2, plus the 8.00 fee.
    expect(boardPrice(piece, 5, FEES).amount).toBeCloseTo(8 + 0.075 * 45, 6);
    expect(computeCost(order({ piece }), FEES).total).toBe(11.38);
  });

  it('prices by area for a quantity the offer does not cover', () => {
    expect(boardPrice({ width: 100, height: 100, layers: 2 }, 50, FEES).amount).toBeCloseTo(8 + 0.5 * 45, 6);
  });

  it('charges more for more layers and more area', () => {
    const at = (layers: 2 | 4 | 6, qty: number): number => boardPrice({ width: 120, height: 120, layers }, qty, FEES).amount;
    expect(at(4, 10)).toBeGreaterThan(at(2, 10));
    expect(at(6, 10)).toBeGreaterThan(at(4, 10));
    expect(at(2, 50)).toBeGreaterThan(at(2, 10));
    // The published data point the 4-layer numbers were fitted to.
    expect(boardPrice({ width: 100, height: 100, layers: 4 }, 100, FEES).amount).toBeCloseTo(70, 0);
  });

  it('never lets the offer cost more than the area price', () => {
    const tiny = boardPrice({ width: 10, height: 10, layers: 4 }, 5, FEES);
    expect(tiny.amount).toBeLessThanOrEqual(7);
  });

  it('adds the different-designs fee per extra design', () => {
    const c = computeCost(order({ piece: { width: 90, height: 60, layers: 2, boards: 6, designs: 3, separation: 'mouse-bite' } }), FEES);
    expect(line(c, 'pcb-designs')).toMatchObject({ amount: 16, estimate: true });
    expect(line(c, 'pcb-designs').detail).toBe('2 extra x 8.00');
    expect(line(c, 'pcb').label).toContain('5 panels');
  });

  it('flags more designs than JLCPCB allows', () => {
    const c = computeCost(order({ piece: { width: 90, height: 60, layers: 2, boards: 12, designs: 11, separation: 'mouse-bite' } }), FEES);
    expect(c.problems).toEqual(['11 different designs in one file; JLCPCB allows 10']);
  });

  it('charges deburring on small boards, with a verified number', () => {
    const c = computeCost(order({ piece: { width: 20, height: 12, layers: 2, boards: 1, designs: 1, separation: 'none' } }), FEES);
    expect(line(c, 'pcb-deburr')).toMatchObject({ amount: 0.25, estimate: false });
    const c2 = computeCost(order({ piece: { width: 40, height: 25, layers: 2, boards: 1, designs: 1, separation: 'none' } }), FEES);
    expect(line(c2, 'pcb-deburr').amount).toBe(0.1);
  });
});

describe('computeCost: assembly', () => {
  it('itemizes an Economic order', () => {
    const c = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [R10K, MCU] } }), FEES);
    expect(line(c, 'asm-setup')).toMatchObject({ amount: 8.18, estimate: false });
    expect(line(c, 'asm-stencil')).toMatchObject({ amount: 1.53, estimate: false });
    // (4 x 2 + 41) joints x 5 boards x 0.0016
    expect(line(c, 'asm-smt')).toMatchObject({ amount: 0.39, estimate: false });
    expect(line(c, 'asm-smt').label).toBe('SMT joints: 245');
    // One extended part; the basic one loads free.
    expect(line(c, 'asm-loading')).toMatchObject({ amount: 3.07, estimate: false });
    expect(c.lines.filter((l) => l.code === 'part')).toHaveLength(2);
    expect(c.lines.map((l) => l.code)).not.toContain('asm-panel');
    expect(c.total).toBeCloseTo(2 + 8.18 + 1.53 + 0.39 + 3.07 + 0.03 + 6 * 3.2, 2);
  });

  it('charges Standard loading for basic parts too, and more setup', () => {
    const c = computeCost(order({ assembly: { type: 'standard', qty: 5, sides: 1, parts: [R10K, MCU] } }), FEES);
    expect(line(c, 'asm-setup').amount).toBe(25.56);
    expect(line(c, 'asm-stencil').amount).toBe(8.21);
    expect(line(c, 'asm-loading').amount).toBe(3.06);
  });

  it('doubles setup and stencil for two sides on Standard, and refuses them on Economic', () => {
    const std = computeCost(order({ assembly: { type: 'standard', qty: 5, sides: 2, parts: [R10K] } }), FEES);
    expect(line(std, 'asm-setup').amount).toBe(51.12);
    expect(line(std, 'asm-stencil').amount).toBe(16.42);
    expect(std.problems).toEqual([]);
    const eco = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 2, parts: [R10K] } }), FEES);
    expect(eco.problems).toEqual(['Economic PCBA places one side only; this order has parts on both']);
  });

  it('charges through-hole joints and the hand-soldering labour once', () => {
    const c = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [R10K, HEADER] } }), FEES);
    expect(line(c, 'asm-tht')).toMatchObject({ amount: 0.66, label: 'Through-hole joints: 40' });
    expect(line(c, 'asm-hand-labor').amount).toBe(3.58);
    const none = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [R10K] } }), FEES);
    expect(none.lines.map((l) => l.code)).not.toContain('asm-hand-labor');
  });

  it('adds the panel fee to an assembled panel, but not to a silk-divided board', () => {
    const asm = { type: 'economic' as const, qty: 5, sides: 1 as const, parts: [R10K] };
    const panel = computeCost(order({ piece: { width: 90, height: 60, layers: 2, boards: 4, designs: 1, separation: 'mouse-bite' }, assembly: asm }), FEES);
    expect(line(panel, 'asm-panel')).toMatchObject({ amount: 8.21, estimate: false });
    const silk = computeCost(order({ piece: { width: 90, height: 60, layers: 2, boards: 4, designs: 1, separation: 'silk-divider' }, assembly: asm }), FEES);
    expect(silk.lines.map((l) => l.code)).not.toContain('asm-panel');
    expect(silk.notes).toContain('Boards divided by silkscreen lines only count as one design; you cut them apart yourself.');
  });

  it('adds the large-board fee above 650 cm2', () => {
    const c = computeCost(order({ piece: { width: 300, height: 220, layers: 2, boards: 1, designs: 1, separation: 'none' }, assembly: { type: 'standard', qty: 5, sides: 1, parts: [R10K] } }), FEES);
    expect(line(c, 'asm-large').amount).toBe(57.46);
  });

  it('bills attrition and minimum quantities', () => {
    const rules = FEES.parts.attrition.value;
    // 20 resistors used: 8 spare. 2 used: the minimum of 20 applies.
    expect(billedQuantity(20, 2, rules)).toMatchObject({ qty: 28, extra: 8 });
    expect(billedQuantity(2, 2, rules)).toMatchObject({ qty: 20, minimum: 20 });
    expect(billedQuantity(5, 41, rules)).toMatchObject({ qty: 6 });
    expect(billedQuantity(5, 6, rules)).toMatchObject({ qty: 8 });
    const c = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [MCU] } }), FEES);
    const part = c.lines.find((l) => l.code === 'part')!;
    expect(part.label).toBe('C2913204 ESP32 x 6');
    expect(part.amount).toBe(19.2);
    expect(part.estimate).toBe(true);
  });

  it("bills a part at JLCPCB's tier for the quantity, with its own attrition, as a verified line", () => {
    const led: OrderPart = {
      ...MCU,
      lcsc: 'C41413180',
      value: 'WS2812B',
      perPiece: 80,
      unitPrice: 9,
      jlc: {
        basic: false,
        standardOnly: true,
        attrition: { loss: 8, minimum: 10 },
        prices: [
          { from: 1, to: 199, price: 0.0344 },
          { from: 200, to: 599, price: 0.0267 },
          { from: 600, to: 3999, price: 0.0223 },
          { from: 4000, to: null, price: 0.0212 },
        ],
      },
    };
    const c = computeCost(order({ assembly: { type: 'standard', qty: 2, sides: 1, parts: [led] } }), FEES);
    const part = c.lines.find((l) => l.code === 'part')!;
    // 160 used + 8 spare = 168, in the 1-199 tier; the EasyEDA price is not used.
    expect(part.label).toBe('C41413180 WS2812B x 168');
    expect(part.amount).toBe(5.78);
    expect(part.estimate).toBe(false);
    expect(part.detail).toContain('billed 168 (JLCPCB: +8 spare, at least 10) x 0.0344 JLCPCB');
    expect(c.notes).toEqual([]);

    const many = computeCost(order({ assembly: { type: 'standard', qty: 10, sides: 1, parts: [led] } }), FEES);
    // 808 billed: the 600-3999 tier.
    expect(many.lines.find((l) => l.code === 'part')!.amount).toBe(18.02);

    const few = computeCost(order({ assembly: { type: 'standard', qty: 2, sides: 1, parts: [{ ...led, perPiece: 1 }] } }), FEES);
    expect(few.lines.find((l) => l.code === 'part')!.label).toBe('C41413180 WS2812B x 10');
  });

  it("uses the fee table's attrition classes, as an estimate, when JLCPCB's library has prices but no attrition", () => {
    const part: OrderPart = { ...R10K, unitPrice: undefined, jlc: { basic: true, standardOnly: false, prices: [{ from: 1, to: null, price: 0.002 }] } };
    const c = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [part] } }), FEES);
    const line = c.lines.find((l) => l.code === 'part')!;
    expect(line.label).toBe('C25804 10k x 28');
    expect(line.amount).toBe(0.06);
    expect(line.estimate).toBe(true);
  });

  it('tierPrice takes the tier the quantity falls in', () => {
    const tiers = [
      { from: 1, to: 9, price: 1 },
      { from: 10, to: null, price: 0.5 },
    ];
    expect(tierPrice(tiers, 1)).toBe(1);
    expect(tierPrice(tiers, 9)).toBe(1);
    expect(tierPrice(tiers, 10)).toBe(0.5);
    expect(tierPrice(tiers, 1000)).toBe(0.5);
    expect(tierPrice([], 5)).toBeUndefined();
    expect(tierPrice(undefined, 5)).toBeUndefined();
  });

  it('lists a part without a price at zero and says so', () => {
    const c = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [{ ...MCU, unitPrice: undefined }] } }), FEES);
    const part = c.lines.find((l) => l.code === 'part')!;
    expect(part.amount).toBe(0);
    expect(part.detail).toContain('unit price unknown');
    expect(c.notes).toContain('No price for C2913204: it is left out of the total.');
  });

  it('reports orders that cannot be placed', () => {
    const tooMany = computeCost(order({ assembly: { type: 'economic', qty: 10, sides: 1, parts: [R10K] } }), FEES);
    expect(tooMany.problems).toContain('10 boards to assemble, but only 5 ordered');
    const beyond = computeCost(order({ pcbQty: 100, assembly: { type: 'economic', qty: 100, sides: 1, parts: [R10K] } }), FEES);
    expect(beyond.problems).toContain('Economic PCBA assembles 2 to 50 pieces per order; 100 asked for');
  });

  it('an order with no parts is a bare-board order', () => {
    const c = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [] } }), FEES);
    expect(c.lines.map((l) => l.code)).toEqual(['pcb']);
  });

  it('the total is the sum of its lines, and an estimate if any line is', () => {
    const c = computeCost(order({ assembly: { type: 'standard', qty: 5, sides: 1, parts: [R10K, MCU, HEADER] } }), FEES);
    expect(c.total).toBeCloseTo(c.lines.reduce((s, l) => s + l.amount, 0), 2);
    expect(c.estimate).toBe(true);
    expect(c.lines.some((l) => !l.estimate)).toBe(true);
    for (const l of c.lines) expect(l.sources.length).toBeGreaterThan(0);
  });

  it('follows the fee table it is given', () => {
    const dear = structuredClone(FEES);
    dear.assembly.economic.setupFee.value.single = 100;
    dear.assembly.economic.setupFee.verified = false;
    const c = computeCost(order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [R10K] } }), dear);
    expect(line(c, 'asm-setup')).toMatchObject({ amount: 100, estimate: true });
  });

  it('is pure: same input, same output, input untouched', () => {
    const o = order({ assembly: { type: 'economic', qty: 5, sides: 1, parts: [R10K, MCU] } });
    const before = structuredClone(o);
    expect(computeCost(o, FEES)).toEqual(computeCost(o, FEES));
    expect(o).toEqual(before);
  });

  it('is fast enough to run on every edit', () => {
    const parts: OrderPart[] = Array.from({ length: 60 }, (_, i) => ({
      lcsc: `C${1000 + i}`,
      basic: i % 3 === 0,
      perPiece: 1 + (i % 5),
      smtJoints: 2 + (i % 40),
      thtJoints: i % 10 === 0 ? 4 : 0,
      unitPrice: 0.01 * (i + 1),
    }));
    const o = order({ piece: { width: 200, height: 150, layers: 4, boards: 12, designs: 3, separation: 'mouse-bite' }, pcbQty: 10, assembly: { type: 'standard', qty: 10, sides: 2, parts } });
    computeCost(o, FEES); // warm up
    const runs = 2000;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) computeCost(o, FEES);
    const each = (performance.now() - t0) / runs;
    console.log(`computeCost, 60 part lines: ${(each * 1000).toFixed(1)} us per call`);
    expect(each).toBeLessThan(1); // 1 ms
  });
});

describe('orders from panels', () => {
  function withParts(src: ResolvedSource, price: number): ResolvedSource {
    return { ...src, geometry: { ...src.geometry!, parts: src.geometry!.parts.map((p) => ({ ...p, unitPrice: price })) } };
  }
  const s = withParts(resolved('S', plainBoard('sensor', 40, 30)), 0.5);
  const m = withParts(resolved('M', plainBoard('mini', 18, 12)), 0.002);

  function arranged(panel: Panel, sources: ResolvedSource[]): Panel {
    const r = arrange(panel, sources, LIMITS);
    if (!r.ok) throw new Error(r.reason);
    return applyAll(panel, { op: 'placeInstances', placements: r.placements });
  }

  it('merges the parts of every populated board, by LCSC id', () => {
    const parts = pieceParts(
      [
        { key: 'S', total: 1, populated: 1 },
        { key: 'M', total: 3, populated: 2 },
      ],
      [s, m],
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ lcsc: 'C25804', perPiece: 3, basic: true, smtJoints: 2, unitPrice: 0.5 });
  });

  it('picks the fewest panels that meet every need', () => {
    const hasParts = (): boolean => true;
    const counts = [
      { key: 'S', total: 1, populated: 1 },
      { key: 'M', total: 3, populated: 3 },
    ];
    // 1 S and 5 M needed: 2 panels give 2 S and 6 M. Boards come in fives.
    expect(quantitiesFor(counts, new Map([['S', 1], ['M', 5]]), hasParts, FEES)).toEqual({ pcb: 5, asm: 2 });
    expect(quantitiesFor(counts, new Map([['S', 1], ['M', 16]]), hasParts, FEES)).toEqual({ pcb: 10, asm: 10 });
    expect(quantitiesFor(counts, new Map([['S', 0], ['M', 0]]), hasParts, FEES)).toEqual({ pcb: 5, asm: 2 });
    expect(
      quantitiesFor([{ key: 'S', total: 1, populated: 0 }], new Map([['S', 1]]), hasParts, FEES),
    ).toEqual({ error: 'no populated S instance to meet the 1 needed' });
  });

  it('counts what each design yields', () => {
    const panel = panelOf([s, m], [], [
      { op: 'setQuantity', key: 'S', needed: 1 },
      { op: 'setQuantity', key: 'M', needed: 5 },
    ]);
    const counts = [
      { key: 'S', total: 1, populated: 1 },
      { key: 'M', total: 3, populated: 3 },
    ];
    expect(receivedFor(panel, counts, 5, 2, () => true)).toEqual([
      { key: 'S', name: 'sensor', needed: 1, assembled: 2, bare: 3, overage: 1, shortfall: 0 },
      { key: 'M', name: 'mini', needed: 5, assembled: 6, bare: 9, overage: 1, shortfall: 0 },
    ]);
  });

  it('quotes the panel as it stands', () => {
    let panel = panelOf([s, m], [
      ['S', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
      ['M', 0, 0],
    ], [{ op: 'setQuantity', key: 'M', needed: 5 }]);
    panel = arranged(panel, [s, m]);
    const geometry = computeGeometry(panel, [s, m]);
    const q = quotePanel(panel, [s, m], geometry, LIMITS, FEES);
    expect(q.problems).toEqual([]);
    expect(q.order).toMatchObject({ pcbQty: 5, assembly: { type: 'economic', qty: 2, sides: 1 } });
    expect(q.order!.piece).toMatchObject({ boards: 4, designs: 2, separation: 'mouse-bite', layers: 2 });
    expect(q.order!.piece.width).toBeCloseTo(geometry.frame!.width, 6);
    expect(q.cost!.lines.map((l) => l.code)).toEqual([
      'pcb',
      'pcb-designs',
      'asm-setup',
      'asm-stencil',
      'asm-smt',
      'asm-panel',
      'part',
    ]);
    expect(q.received.map((r) => [r.key, r.assembled, r.overage])).toEqual([
      ['S', 2, 1],
      ['M', 6, 1],
    ]);
    // Standard cannot take a panel this small.
    expect(q.notes.some((n) => /Standard PCBA: .* under the 70 x 70 mm minimum/.test(n))).toBe(true);
  });

  it('prices a panel of bare boards without assembly', () => {
    let panel = panelOf([s], [
      ['S', 0, 0, { populate: false }],
      ['S', 0, 0, { populate: false }],
    ], [{ op: 'setQuantity', key: 'S', needed: 0 }]);
    panel = arranged(panel, [s]);
    const q = quotePanel(panel, [s], computeGeometry(panel, [s]), LIMITS, FEES);
    expect(q.order).toMatchObject({ pcbQty: 5 });
    expect(q.order!.assembly).toBeUndefined();
    expect(q.cost!.lines.map((l) => l.code)).toEqual(['pcb']);
  });

  it('reports a needed design that is missing, and still prices the rest', () => {
    const panel = arranged(panelOf([s, m], [['S', 0, 0]]), [s, m]);
    const q = quotePanel(panel, [s, m], computeGeometry(panel, [s, m]), LIMITS, FEES);
    expect(q.problems).toEqual(['M: 1 needed, none on the panel']);
    expect(q.cost).not.toBeNull();
    expect(q.received.find((r) => r.key === 'M')).toMatchObject({ assembled: 0, shortfall: 1 });
  });

  it('cannot price mixed layer counts until the panel is promoted', () => {
    const four = withParts(resolved('F', plainBoard('four', 30, 20, 4)), 0.1);
    let panel = arranged(panelOf([s, four], [
      ['S', 0, 0],
      ['F', 0, 0],
    ]), [s, four]);
    expect(quotePanel(panel, [s, four], computeGeometry(panel, [s, four]), LIMITS, FEES).problems[0]).toContain(
      'different layer counts',
    );
    panel = applyAll(panel, { op: 'setSettings', settings: { copperLayers: 4 } });
    const q = quotePanel(panel, [s, four], computeGeometry(panel, [s, four]), LIMITS, FEES);
    expect(q.order!.piece.layers).toBe(4);
    expect(q.cost!.total).toBeGreaterThan(0);
  });

  it('knows which service can take what', () => {
    const small = { width: 60, height: 40, layers: 2 as const, boards: 4, designs: 1, separation: 'mouse-bite' as const };
    expect(assemblyEligibility('economic', small, 1, 5, true, LIMITS, FEES)).toEqual({ eligible: true });
    expect(assemblyEligibility('standard', small, 1, 5, true, LIMITS, FEES).reason).toContain('under the 70 x 70 mm minimum');
    expect(assemblyEligibility('economic', small, 2, 5, true, LIMITS, FEES).reason).toBe('Economic PCBA places one side only');
    expect(assemblyEligibility('economic', small, 1, 75, true, LIMITS, FEES).reason).toBe('Economic PCBA assembles 2 to 50 pieces per order');
    const big = { ...small, width: 120, height: 90 };
    expect(assemblyEligibility('standard', big, 2, 75, true, LIMITS, FEES)).toEqual({ eligible: true });
    expect(assemblyEligibility('standard', big, 1, 5, false, LIMITS, FEES).reason).toBe('Standard PCBA needs edge rails and fiducials on a panel');
    expect(assemblyEligibility('economic', { ...big, separation: 'solid-tab' }, 1, 5, true, LIMITS, FEES).reason).toContain('not solid-tab');
    const standardOnly: OrderPart = { ...MCU, jlc: { basic: false, standardOnly: true } };
    expect(assemblyEligibility('economic', small, 1, 5, true, LIMITS, FEES, [R10K, standardOnly]).reason).toBe(
      "Economic PCBA cannot place C2913204: Standard only in JLCPCB's parts library",
    );
    expect(assemblyEligibility('standard', big, 1, 5, true, LIMITS, FEES, [R10K, standardOnly])).toEqual({ eligible: true });
    expect(assemblyEligibility('economic', small, 1, 5, true, LIMITS, FEES, [R10K, { ...MCU, jlc: { basic: false, standardOnly: false } }])).toEqual({ eligible: true });
  });
});
