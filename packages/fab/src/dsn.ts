/**
 * Flamingo Fab - Specctra DSN export
 *
 * Emits a Specctra `.dsn` design file for the Freerouting autorouter.
 *
 * Units / coordinates: all DSN numbers are plain micrometre (µm) integers
 * (mm x 1000, rounded). We declare `(resolution um 1)` so 1 coordinate unit
 * == 1 µm — lossless at 1 µm and trivially readable. Specctra is y-up like
 * our engine, so coordinates pass through with NO y-flip.
 *
 * Bottom-side components: emitted as `(place ... back <rot>)`. Specctra
 * mirrors the component image across its local Y axis (x -> -x) for back-side
 * placement, which matches our engine's bottom-side convention
 * (componentTransformPoints: mirror x, then rotate, then translate). This is
 * verified by a round-trip test in test/dsn.test.ts.
 *
 * Padstacks are defined in footprint-local ("as-if front") layers: a
 * footprint-local `top` pad puts copper on F.Cu, `bottom` on B.Cu, `through`
 * on every copper layer. Specctra's back-side mirror flips F.Cu <-> B.Cu for
 * back-side components, so the image itself stays side-independent.
 */

import type { Board, ComponentInst, LayerId, Net, NetClass, Pad, Point, Track } from '@flamingo/engine';
import { copperLayersOf, boardBBox, outlineToPolygon, padOutline } from '@flamingo/engine';

const HOST_CAD = 'flamingo';
const HOST_VERSION = '0.1.0';

export interface ExportDSNOptions {
  /**
   * If given, the `(network)` section contains ONLY these nets (the ones we
   * are about to route). Every OTHER net's existing tracks/vias are emitted
   * in `(wiring)` as `(type protect)` obstacles so the router respects them.
   * If omitted, the full network is emitted and no wiring is written (a fresh
   * route of everything).
   */
  nets?: string[];
}

// ---------------------------------------------------------------------------
// Number / token formatting
// ---------------------------------------------------------------------------

/** mm -> integer micrometres (normalising -0 to 0). */
function um(mm: number): number {
  return Math.round(mm * 1000) + 0;
}

/** Does a token need to be double-quoted in DSN output? */
function needsQuote(s: string): boolean {
  return s.length === 0 || /[\s()"]/.test(s);
}

/** Quote a token if necessary (net names / ids with spaces etc.). */
function tok(s: string): string {
  return needsQuote(s) ? `"${s}"` : s;
}

// ---------------------------------------------------------------------------
// Stable hashing (for polygon padstack names)
// ---------------------------------------------------------------------------

function hash8(s: string): string {
  // FNV-1a 32-bit, hex.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Padstack modelling
// ---------------------------------------------------------------------------

/** Footprint-local copper layers a pad occupies ("as-if front"). */
function padStackLayers(b: Board, pad: Pad): LayerId[] {
  if (pad.layer === 'through') return copperLayersOf(b);
  return [pad.layer === 'top' ? 'F.Cu' : 'B.Cu'];
}

function layerTag(pad: Pad): string {
  if (pad.layer === 'through') return 'TH';
  return pad.layer === 'top' ? 'F' : 'B';
}

/** Pad outline centred at the pad origin, with pad.rotation baked in. */
function padLocalShape(pad: Pad): Point[] {
  const idComp: ComponentInst = {
    refdes: '',
    lcsc: '',
    footprint: { name: '', lcsc: '', pads: [], silk: [], courtyard: [] },
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: {},
  };
  return padOutline(idComp, pad).map((p) => ({ x: p.x - pad.at.x, y: p.y - pad.at.y }));
}

interface PadStack {
  name: string;
  /** shape forms already indented by the caller, one per layer. */
  shapeForms: string[];
}

/**
 * Compute the padstack name + per-layer shape forms for a pad. The name is a
 * pure function of (shape, w, h, drill, layer-side), so two pads with the same
 * geometry produce the same name and dedupe to one padstack.
 */
function padStackFor(b: Board, pad: Pad): PadStack {
  const layers = padStackLayers(b, pad);
  const tag = layerTag(pad);
  const drillTag = pad.drill ? `_d${um(pad.drill.diameter)}` : '';
  const w = um(pad.size.w);
  const h = um(pad.size.h);
  const rotMod = ((pad.rotation % 180) + 180) % 180;
  const rotated = Math.abs(rotMod) > 1e-6;

  let name: string;
  let form: (layer: LayerId) => string;

  if (pad.shape === 'circle') {
    name = `circle_${w}${drillTag}_${tag}`;
    form = (layer) => `(circle ${layer} ${w})`;
  } else if (pad.shape === 'polygon' || rotated) {
    const pts = padLocalShape(pad);
    const coords = pts.map((p) => `${um(p.x)} ${um(p.y)}`).join(' ');
    name = `poly_${hash8(`${coords}|${tag}${drillTag}`)}_${tag}`;
    form = (layer) => `(polygon ${layer} 0 ${coords})`;
  } else if (pad.shape === 'rect') {
    name = `rect_${w}x${h}${drillTag}_${tag}`;
    const x1 = um(-pad.size.w / 2);
    const y1 = um(-pad.size.h / 2);
    const x2 = um(pad.size.w / 2);
    const y2 = um(pad.size.h / 2);
    form = (layer) => `(rect ${layer} ${x1} ${y1} ${x2} ${y2})`;
  } else {
    // oval, axis-aligned: represent as a stroked path (stadium).
    name = `oval_${w}x${h}${drillTag}_${tag}`;
    const width = Math.min(w, h);
    const long = Math.max(w, h) - width;
    const half = Math.round(long / 2);
    const line =
      w >= h ? `${-half} 0 ${half} 0` : `0 ${-half} 0 ${half}`;
    form = (layer) => `(path ${layer} ${width} ${line})`;
  }

  const shapeForms = layers.map((layer) => `(shape ${form(layer)})`);
  return { name, shapeForms };
}

/** Via padstack name from drill/diameter (µm), e.g. V_300_600. */
function viaPadStackName(drillMm: number, diaMm: number): string {
  return `V_${um(drillMm)}_${um(diaMm)}`;
}

function viaPadStackForms(b: Board, diaMm: number): string[] {
  const dia = um(diaMm);
  return copperLayersOf(b).map((layer) => `(shape (circle ${layer} ${dia}))`);
}

// ---------------------------------------------------------------------------
// Track path tessellation (for protect wiring)
// ---------------------------------------------------------------------------

function trackPoints(t: Track): Point[] {
  const seg = t.seg;
  if (seg.type === 'line') return [seg.start, seg.end];
  // Arc: tessellate into a polyline (obstacle approximation for protect wires).
  const { start, end, center, cw } = seg;
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const twoPi = 2 * Math.PI;
  let sweep = cw ? (((a0 - a1) % twoPi) + twoPi) % twoPi : (((a1 - a0) % twoPi) + twoPi) % twoPi;
  if (sweep < 1e-12) sweep = twoPi;
  const steps = Math.max(2, Math.ceil((sweep * r) / 0.2));
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = cw ? a0 - (sweep * i) / steps : a0 + (sweep * i) / steps;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Board boundary
// ---------------------------------------------------------------------------

function boundaryPath(b: Board): string {
  let pts: Point[];
  if (b.outline.length > 0) {
    pts = outlineToPolygon(b.outline);
  } else {
    const bb = boardBBox(b);
    pts = [
      { x: bb.minX, y: bb.minY },
      { x: bb.maxX, y: bb.minY },
      { x: bb.maxX, y: bb.maxY },
      { x: bb.minX, y: bb.maxY },
    ];
  }
  const nums: number[] = [];
  for (const p of pts) nums.push(um(p.x), um(p.y));
  // close the ring
  nums.push(um(pts[0].x), um(pts[0].y));
  return `(path pcb 0 ${nums.join(' ')})`;
}

// ---------------------------------------------------------------------------
// Net class resolution
// ---------------------------------------------------------------------------

function netClassOf(b: Board, net: Net): NetClass {
  return (
    b.netClasses.find((c) => c.name === net.class) ??
    b.netClasses.find((c) => c.name === 'default') ??
    { name: 'default', trackWidth: 0.25, clearance: 0.2, viaDrill: 0.3, viaDiameter: 0.6 }
  );
}

function defaultNetClass(b: Board): NetClass {
  return (
    b.netClasses.find((c) => c.name === 'default') ??
    { name: 'default', trackWidth: 0.25, clearance: 0.2, viaDrill: 0.3, viaDiameter: 0.6 }
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportDSN(b: Board, opts: ExportDSNOptions = {}): string {
  const nets = opts.nets;
  const includeNet = (name: string): boolean => (nets ? nets.includes(name) : true);

  // Nets that go into the (network) section: routable (>=2 pins) and included.
  const networkNets = b.nets.filter((n) => n.pins.length >= 2 && includeNet(n.name));

  // ---- Images (deduped by footprint name; pads share padstacks) ----
  const imageOrder: string[] = [];
  const imageByName = new Map<string, ComponentInst>();
  for (const c of b.components) {
    const id = c.footprint.name;
    if (!imageByName.has(id)) {
      imageByName.set(id, c);
      imageOrder.push(id);
    }
  }

  // ---- Padstacks (deduped by geometry-derived name) ----
  const padStacks = new Map<string, string[]>(); // name -> shapeForms
  const padStackNameOf = new Map<Pad, string>();
  for (const id of imageOrder) {
    const comp = imageByName.get(id)!;
    for (const pad of comp.footprint.pads) {
      const ps = padStackFor(b, pad);
      padStackNameOf.set(pad, ps.name);
      if (!padStacks.has(ps.name)) padStacks.set(ps.name, ps.shapeForms);
    }
  }

  // ---- Via padstacks (from included net classes + any protect vias) ----
  const viaStacks = new Map<string, string[]>(); // name -> shapeForms
  const viaNameByClass = new Map<string, string>(); // netclass name -> via padstack
  for (const net of networkNets) {
    const nc = netClassOf(b, net);
    const vName = viaPadStackName(nc.viaDrill, nc.viaDiameter);
    if (!viaStacks.has(vName)) viaStacks.set(vName, viaPadStackForms(b, nc.viaDiameter));
    viaNameByClass.set(nc.name, vName);
  }

  // ---- Protect wiring (only when subsetting) ----
  const protectTracks: Track[] = nets ? b.tracks.filter((t) => !includeNet(t.net)) : [];
  const protectVias = nets ? b.vias.filter((v) => !includeNet(v.net)) : [];
  for (const v of protectVias) {
    const vName = viaPadStackName(v.drill, v.diameter);
    if (!viaStacks.has(vName)) viaStacks.set(vName, viaPadStackForms(b, v.diameter));
  }

  const dnc = defaultNetClass(b);
  const L = copperLayersOf(b);

  // ---- Assemble ----
  const out: string[] = [];
  out.push(`(pcb ${tok(b.name)}`);
  out.push('  (parser');
  out.push('    (string_quote ")');
  out.push('    (space_in_quoted_tokens on)');
  out.push(`    (host_cad ${HOST_CAD})`);
  out.push(`    (host_version ${HOST_VERSION})`);
  out.push('  )');
  out.push('  (resolution um 1)');
  out.push('  (unit um)');

  // structure
  out.push('  (structure');
  for (const layer of L) out.push(`    (layer ${layer} (type signal))`);
  out.push(`    (boundary ${boundaryPath(b)})`);
  // copper keepouts
  for (const k of b.keepouts) {
    if (!k.keepout.copper) continue;
    const coords = k.polygon.map((p) => `${um(p.x)} ${um(p.y)}`).join(' ');
    const kLayers = k.layers === 'all' ? L : k.layers.filter((l) => L.includes(l));
    for (const layer of kLayers) out.push(`    (keepout "" (polygon ${layer} 0 ${coords}))`);
  }
  // via keepouts
  for (const k of b.keepouts) {
    if (!k.keepout.via) continue;
    const coords = k.polygon.map((p) => `${um(p.x)} ${um(p.y)}`).join(' ');
    out.push(`    (via_keepout "" (polygon signal 0 ${coords}))`);
  }
  const allViaNames = [...viaStacks.keys()];
  if (allViaNames.length > 0) out.push(`    (via ${allViaNames.join(' ')})`);
  out.push(`    (rule (width ${um(dnc.trackWidth)}) (clearance ${um(dnc.clearance)}))`);
  out.push('  )');

  // placement
  out.push('  (placement');
  for (const id of imageOrder) {
    out.push(`    (component ${tok(id)}`);
    for (const c of b.components) {
      if (c.footprint.name !== id) continue;
      const side = c.side === 'bottom' ? 'back' : 'front';
      out.push(`      (place ${tok(c.refdes)} ${um(c.at.x)} ${um(c.at.y)} ${side} ${c.rotation})`);
    }
    out.push('    )');
  }
  out.push('  )');

  // library
  out.push('  (library');
  for (const id of imageOrder) {
    const comp = imageByName.get(id)!;
    out.push(`    (image ${tok(id)}`);
    for (const pad of comp.footprint.pads) {
      const psName = padStackNameOf.get(pad)!;
      out.push(`      (pin ${psName} ${tok(pad.number)} ${um(pad.at.x)} ${um(pad.at.y)})`);
    }
    out.push('    )');
  }
  for (const [name, forms] of padStacks) {
    out.push(`    (padstack ${name} ${forms.join(' ')} (attach off))`);
  }
  for (const [name, forms] of viaStacks) {
    out.push(`    (padstack ${name} ${forms.join(' ')} (attach off))`);
  }
  out.push('  )');

  // network
  out.push('  (network');
  for (const net of networkNets) {
    const pins = net.pins.map((p) => p.replace('.', '-')).join(' ');
    out.push(`    (net ${tok(net.name)} (pins ${pins}))`);
  }
  // classes: group included nets by their class
  const byClass = new Map<string, string[]>();
  const classOrder: string[] = [];
  for (const net of networkNets) {
    const nc = netClassOf(b, net);
    if (!byClass.has(nc.name)) {
      byClass.set(nc.name, []);
      classOrder.push(nc.name);
    }
    byClass.get(nc.name)!.push(net.name);
  }
  for (const cname of classOrder) {
    const members = byClass.get(cname)!;
    const nc = b.netClasses.find((c) => c.name === cname) ?? dnc;
    const vName = viaNameByClass.get(cname);
    const memberToks = members.map((m) => tok(m)).join(' ');
    const circuit = vName ? ` (circuit (use_via ${vName}))` : '';
    out.push(
      `    (class ${tok(cname)} ${memberToks}${circuit} (rule (width ${um(nc.trackWidth)}) (clearance ${um(nc.clearance)})))`,
    );
  }
  out.push('  )');

  // wiring (protect obstacles only when subsetting)
  if (protectTracks.length > 0 || protectVias.length > 0) {
    out.push('  (wiring');
    for (const t of protectTracks) {
      const coords = trackPoints(t)
        .map((p) => `${um(p.x)} ${um(p.y)}`)
        .join(' ');
      out.push(
        `    (wire (path ${t.layer} ${um(t.width)} ${coords}) (net ${tok(t.net)}) (type protect))`,
      );
    }
    for (const v of protectVias) {
      const vName = viaPadStackName(v.drill, v.diameter);
      out.push(`    (via ${vName} ${um(v.at.x)} ${um(v.at.y)} (net ${tok(v.net)}) (type protect))`);
    }
    out.push('  )');
  }

  out.push(')');
  out.push('');
  return out.join('\n');
}
