/**
 * Server-generated interactive 3D board viewer.
 *
 * GET /3d renders the current in-memory board into a self-contained HTML page
 * (three.js from CDN) so placement can be reviewed in 3D at any time. The
 * geometry is regenerated from the live board on every request: real pad
 * shapes, tracks, vias, zone fills, footprint silkscreen, plated barrels, and
 * per-package-height component bodies with refdes labels — all toggleable.
 *
 * Component bodies are extruded courtyard bounding boxes with height
 * heuristics — a review aid; STEP export (step.ts) shares the same solids.
 */

import type { Board, ComponentInst, PathSeg, Point } from '@flamingo/engine';
import {
  bboxOf,
  componentTransformPoints,
  holeSlotCenterline,
  padOutline,
} from '@flamingo/engine';

export const BOARD_T = 1.6;

export function componentHeight(c: ComponentInst): number {
  const r = c.refdes;
  const v = c.fields?.value ?? '';
  const fp = c.footprint.name ?? '';
  if (r.startsWith('H') && /2\.54|WALTER|HDR/i.test(fp + ' ' + v)) return 8.5;
  if (/USB/i.test(fp + ' ' + v)) return 3.2;
  if (/JST|SH-?1|BATT|LRA/i.test(fp + ' ' + v)) return 4.3;
  if (/UFL|U\.FL|IPEX/i.test(fp + ' ' + v)) return 2.5;
  if (/FPC/i.test(fp + ' ' + v)) return 2.0;
  if (/^ANT/.test(r)) return 2.4;
  if (/^BZ/.test(r) || /PIEZO/i.test(v)) return 3.0;
  if (/^SW/.test(r)) return 3.75;
  if (/^L\d/.test(r) && /uH/i.test(v)) return 3.0;
  if (/^U\d/.test(r)) return 1.2;
  if (/^Q\d/.test(r)) return 1.1;
  if (/^LED/.test(r)) return 0.6;
  if (/^C\d/.test(r) && /22u/i.test(v)) return 1.4;
  if (/^[RD]\d/.test(r)) return 0.7;
  return 0.9;
}

/**
 * World-space axis-aligned body box for a component: courtyard rings (or pad
 * outlines when the footprint has no courtyard) through the full component
 * transform (mirror + rotation + translation), plus the height heuristic.
 */
export function componentBox(c: ComponentInst): { x0: number; y0: number; x1: number; y1: number; h: number } | null {
  const pts: Point[] = [];
  for (const ring of c.footprint.courtyard ?? []) pts.push(...componentTransformPoints(c, ring));
  if (pts.length === 0) for (const pad of c.footprint.pads) pts.push(...padOutline(c, pad));
  if (pts.length === 0) return null;
  const bb = bboxOf(pts);
  if (!(bb.maxX > bb.minX) || !(bb.maxY > bb.minY)) return null;
  return { x0: bb.minX, y0: bb.minY, x1: bb.maxX, y1: bb.maxY, h: componentHeight(c) };
}

// ---------------------------------------------------------------------------
// Geometry extraction
// ---------------------------------------------------------------------------

type XY = [number, number];
/** Line piece [x0,y0,x1,y1,sideSign] — sideSign 1 = top, -1 = bottom. */
type SidedSeg = [number, number, number, number, number];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Tessellate a track/silk arc (world coords, cw = visually clockwise) into line pieces. */
function arcPoints(start: Point, end: Point, center: Point, cw: boolean): Point[] {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (r < 1e-6) return [start, end];
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const twoPi = 2 * Math.PI;
  let sweep = cw ? (((a0 - a1) % twoPi) + twoPi) % twoPi : (((a1 - a0) % twoPi) + twoPi) % twoPi;
  if (sweep < 1e-9) sweep = twoPi;
  const steps = Math.max(4, Math.min(48, Math.ceil(sweep / (2 * Math.acos(Math.max(0.2, 1 - 0.05 / r))))));
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = cw ? a0 - (sweep * i) / steps : a0 + (sweep * i) / steps;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

function segPieces(seg: PathSeg): Point[] {
  if (seg.type === 'line') return [seg.start, seg.end];
  return arcPoints(seg.start, seg.end, seg.center, seg.cw);
}

interface Viewer3dData {
  name: string;
  T: number;
  outline: Board['outline'];
  /** Drill cutout rings (world polygons) punched through the board shape. */
  cutouts: XY[][];
  /** Plated barrels: [x, y, radius]. */
  barrels: [number, number, number][];
  comps: { r: string; x0: number; y0: number; x1: number; y1: number; h: number; k: string; side: string }[];
  /** Pad polygons: { p: ring, s: 1 top / -1 bottom / 0 through }. */
  pads: { p: XY[]; s: number }[];
  tracks: SidedSeg[];
  zones: { p: XY[]; s: number; filled: boolean }[];
  silk: SidedSeg[];
  labels: [string, number, number, number][];
  keepouts: XY[][];
}

function extractData(board: Board): Viewer3dData {
  const comps: Viewer3dData['comps'] = [];
  const pads: Viewer3dData['pads'] = [];
  const labels: Viewer3dData['labels'] = [];
  const silk: SidedSeg[] = [];
  const cutouts: XY[][] = [];
  const barrels: [number, number, number][] = [];

  const pushSilkSeg = (a: Point, b: Point, sideSign: number): void => {
    silk.push([r2(a.x), r2(a.y), r2(b.x), r2(b.y), sideSign]);
  };

  for (const c of board.components) {
    const sideSign = c.side === 'bottom' ? -1 : 1;
    const box = componentBox(c);
    if (box) {
      const kind = /^(J|H)/.test(c.refdes) ? (c.refdes.startsWith('H') ? 'hdr' : 'conn') : c.refdes === 'ANT1' ? 'ant' : 'part';
      comps.push({
        r: c.refdes,
        x0: r2(box.x0),
        y0: r2(box.y0),
        x1: r2(box.x1),
        y1: r2(box.y1),
        h: box.h,
        k: kind,
        side: c.side,
      });
      labels.push([c.refdes, r2((box.x0 + box.x1) / 2), r2((box.y0 + box.y1) / 2), sideSign]);
    }

    for (const pad of c.footprint.pads) {
      const ring = padOutline(c, pad).map((p): XY => [r2(p.x), r2(p.y)]);
      pads.push({ p: ring, s: pad.layer === 'through' ? 0 : sideSign });
      if (pad.drill) {
        const [at] = componentTransformPoints(c, [pad.at]);
        const rr = pad.drill.diameter / 2;
        cutouts.push(circleRing(at, rr));
        barrels.push([r2(at.x), r2(at.y), r2(rr + 0.15)]);
      }
    }

    const mirror = c.side === 'bottom';
    for (const item of c.footprint.silk) {
      if (item.kind === 'line') {
        const [a, b] = componentTransformPoints(c, [item.start, item.end]);
        pushSilkSeg(a, b, sideSign);
      } else if (item.kind === 'arc') {
        const [ws, we, wc] = componentTransformPoints(c, [item.start, item.end, item.center]);
        const worldCw = mirror ? !item.cw : item.cw;
        const pts = arcPoints(ws, we, wc, worldCw);
        for (let i = 0; i < pts.length - 1; i++) pushSilkSeg(pts[i], pts[i + 1], sideSign);
      } else if (item.kind === 'circle') {
        const [wc] = componentTransformPoints(c, [item.center]);
        const pts = arcPoints(
          { x: wc.x + item.radius, y: wc.y },
          { x: wc.x + item.radius, y: wc.y },
          wc,
          false,
        );
        for (let i = 0; i < pts.length - 1; i++) pushSilkSeg(pts[i], pts[i + 1], sideSign);
      }
    }
  }

  for (const line of board.silkLines) {
    pushSilkSeg(line.start, line.end, line.layer === 'B.Silk' ? -1 : 1);
  }

  for (const h of board.holes) {
    const { start, end } = holeSlotCenterline(h);
    cutouts.push(capsuleRing(start, end, h.drill / 2));
    if (h.plated && start.x === end.x && start.y === end.y) {
      barrels.push([r2(h.at.x), r2(h.at.y), r2(h.drill / 2 + 0.2)]);
    }
  }
  for (const v of board.vias) {
    cutouts.push(circleRing(v.at, v.drill / 2));
    barrels.push([r2(v.at.x), r2(v.at.y), r2(v.diameter / 2)]);
  }

  const tracks: SidedSeg[] = [];
  for (const t of board.tracks) {
    if (t.layer !== 'F.Cu' && t.layer !== 'B.Cu') continue;
    const sideSign = t.layer === 'B.Cu' ? -1 : 1;
    const pts = segPieces(t.seg);
    for (let i = 0; i < pts.length - 1; i++) {
      tracks.push([r2(pts[i].x), r2(pts[i].y), r2(pts[i + 1].x), r2(pts[i + 1].y), sideSign * (t.width * 100)]);
    }
  }

  const zones: Viewer3dData['zones'] = [];
  for (const z of board.zones) {
    if (z.layer !== 'F.Cu' && z.layer !== 'B.Cu') continue;
    const s = z.layer === 'B.Cu' ? -1 : 1;
    if (z.fill && z.fill.length > 0) {
      for (const poly of z.fill) zones.push({ p: poly.map((p): XY => [r2(p.x), r2(p.y)]), s, filled: true });
    } else {
      zones.push({ p: z.polygon.map((p): XY => [r2(p.x), r2(p.y)]), s, filled: false });
    }
  }

  return {
    name: board.name,
    T: BOARD_T,
    outline: board.outline,
    cutouts,
    barrels,
    comps,
    pads,
    tracks,
    zones,
    silk,
    labels,
    keepouts: board.keepouts.map((k) => k.polygon.map((p): XY => [r2(p.x), r2(p.y)])),
  };

  function circleRing(at: Point, radius: number): XY[] {
    const pts = arcPoints({ x: at.x + radius, y: at.y }, { x: at.x + radius, y: at.y }, at, false);
    return pts.slice(0, -1).map((p): XY => [r2(p.x), r2(p.y)]);
  }

  function capsuleRing(start: Point, end: Point, radius: number): XY[] {
    if (start.x === end.x && start.y === end.y) return circleRing(start, radius);
    const rot = Math.atan2(end.y - start.y, end.x - start.x);
    const ring: Point[] = [
      ...arcPoints(
        { x: end.x + radius * Math.cos(rot - Math.PI / 2), y: end.y + radius * Math.sin(rot - Math.PI / 2) },
        { x: end.x + radius * Math.cos(rot + Math.PI / 2), y: end.y + radius * Math.sin(rot + Math.PI / 2) },
        end,
        false,
      ),
      ...arcPoints(
        { x: start.x + radius * Math.cos(rot + Math.PI / 2), y: start.y + radius * Math.sin(rot + Math.PI / 2) },
        { x: start.x + radius * Math.cos(rot - Math.PI / 2), y: start.y + radius * Math.sin(rot - Math.PI / 2) },
        start,
        false,
      ),
    ];
    return ring.map((p): XY => [r2(p.x), r2(p.y)]);
  }
}

export function render3dHtml(board: Board): string {
  const data = JSON.stringify(extractData(board));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${board.name} 3D</title>
<style>
body{margin:0;background:#14161a;color:#ccc;font:12px 'Space Mono','Menlo',monospace}
#hud{position:fixed;top:8px;left:10px;z-index:2;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
#hud a{color:#8ac}
#hud label{cursor:pointer;user-select:none}
#hud .btn{border:1px solid #555;padding:3px 10px;color:#eee;text-decoration:none;text-transform:uppercase;letter-spacing:0.05em;font-size:11px}
#hud .btn:hover{opacity:0.6}
</style>
</head><body>
<div id="hud">
  <b>${board.name} 3D</b>
  <span>drag = orbit · wheel = zoom · shift-drag = pan</span>
  <label><input type="checkbox" id="tParts" checked> parts</label>
  <label><input type="checkbox" id="tPads" checked> pads</label>
  <label><input type="checkbox" id="tTracks" checked> tracks</label>
  <label><input type="checkbox" id="tZones" checked> zones</label>
  <label><input type="checkbox" id="tSilk" checked> silk</label>
  <label><input type="checkbox" id="tLabels"> labels</label>
  <a class="btn" href="/api/export.step" download>Export STEP</a>
  <a href="/">back to editor</a>
</div>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const D=${data};
const pts=[];
for(const s of D.outline){ pts.push(s.start,s.end); }
const minX=Math.min(...pts.map(p=>p.x)), maxX=Math.max(...pts.map(p=>p.x));
const minY=Math.min(...pts.map(p=>p.y)), maxY=Math.max(...pts.map(p=>p.y));
const W=maxX-minX, H=maxY-minY;
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x14161a);
const cam=new THREE.PerspectiveCamera(40,innerWidth/innerHeight,1,2000);
cam.position.set(minX+W/2-20,minY-H*0.7,H*1.1); cam.up.set(0,0,1);
const ren=new THREE.WebGLRenderer({antialias:true}); ren.setSize(innerWidth,innerHeight);
document.body.appendChild(ren.domElement);
const ctl=new OrbitControls(cam,ren.domElement); ctl.target.set(minX+W/2,minY+H/2,0);
scene.add(new THREE.AmbientLight(0xffffff,0.5));
scene.add(new THREE.HemisphereLight(0xbfd0e0,0x30281f,0.35));
const dl=new THREE.DirectionalLight(0xffffff,1.1); dl.position.set(60,-80,120); scene.add(dl);
const dl2=new THREE.DirectionalLight(0x8899ff,0.35); dl2.position.set(-40,60,-80); scene.add(dl2);

function segAngles(s){
  const a0=Math.atan2(s.start.y-s.center.y,s.start.x-s.center.x);
  const a1=Math.atan2(s.end.y-s.center.y,s.end.x-s.center.x);
  return [a0,a1];
}
// Board: outline shape with every drill (holes, TH pads, vias) punched out.
const sh=new THREE.Shape();
D.outline.forEach((s,i)=>{
  if(i===0) sh.moveTo(s.start.x,s.start.y);
  if(s.type==='line') sh.lineTo(s.end.x,s.end.y);
  else { const r=Math.hypot(s.start.x-s.center.x,s.start.y-s.center.y);
    const [a0,a1]=segAngles(s); sh.absarc(s.center.x,s.center.y,r,a0,a1,s.cw); }
});
for(const ring of D.cutouts){
  const p=new THREE.Path(ring.map(q=>new THREE.Vector2(q[0],q[1])));
  p.closePath(); sh.holes.push(p);
}
const board=new THREE.Mesh(new THREE.ExtrudeGeometry(sh,{depth:D.T,bevelEnabled:false,curveSegments:24}),
  new THREE.MeshStandardMaterial({color:0x4a2340,roughness:0.7,metalness:0.1}));
scene.add(board);

const gold=new THREE.MeshStandardMaterial({color:0xd8b545,roughness:0.35,metalness:0.85});
const goldDark=new THREE.MeshStandardMaterial({color:0xb5923a,roughness:0.4,metalness:0.8});

// Pads: true outlines extruded as thin plates (through-pads plate both faces).
const gPads=new THREE.Group(); scene.add(gPads);
function padMesh(ring,z0,depth){
  const s=new THREE.Shape(ring.map(q=>new THREE.Vector2(q[0],q[1])));
  const m=new THREE.Mesh(new THREE.ExtrudeGeometry(s,{depth,bevelEnabled:false}),gold);
  m.position.z=z0; return m;
}
for(const p of D.pads){
  if(p.s===0){ gPads.add(padMesh(p.p,D.T,0.06)); gPads.add(padMesh(p.p,-0.06,0.06)); }
  else if(p.s>0) gPads.add(padMesh(p.p,D.T,0.06));
  else gPads.add(padMesh(p.p,-0.06,0.06));
}
// Plated barrels through the drills.
for(const b of D.barrels){
  const tube=new THREE.Mesh(new THREE.CylinderGeometry(b[2],b[2],D.T+0.1,24,1,true),goldDark);
  tube.rotation.x=Math.PI/2; tube.position.set(b[0],b[1],D.T/2); gPads.add(tube);
}

// Tracks: flat oriented boxes per segment piece (width encoded in seg[4]).
const gTracks=new THREE.Group(); scene.add(gTracks);
{
  const geo=new THREE.BoxGeometry(1,1,0.04);
  const inst=new THREE.InstancedMesh(geo,goldDark,D.tracks.length);
  const m4=new THREE.Matrix4(), q=new THREE.Quaternion(), zAxis=new THREE.Vector3(0,0,1);
  D.tracks.forEach((t,i)=>{
    const w=Math.abs(t[4])/100, side=t[4]>=0?1:-1;
    const dx=t[2]-t[0], dy=t[3]-t[1];
    const len=Math.hypot(dx,dy)||0.001;
    q.setFromAxisAngle(zAxis,Math.atan2(dy,dx));
    m4.compose(new THREE.Vector3((t[0]+t[2])/2,(t[1]+t[3])/2,side>0?D.T+0.02:-0.02),q,new THREE.Vector3(len+w*0.6,w,1));
    inst.setMatrixAt(i,m4);
  });
  gTracks.add(inst);
}

// Zones: filled polys as copper sheets, unfilled outlines as translucent hints.
const gZones=new THREE.Group(); scene.add(gZones);
for(const z of D.zones){
  const s=new THREE.Shape(z.p.map(q=>new THREE.Vector2(q[0],q[1])));
  const mat=z.filled? new THREE.MeshStandardMaterial({color:0xb5923a,roughness:0.45,metalness:0.7,side:THREE.DoubleSide})
    : new THREE.MeshBasicMaterial({color:0xd8b545,transparent:true,opacity:0.10,side:THREE.DoubleSide});
  const m=new THREE.Mesh(new THREE.ShapeGeometry(s),mat);
  m.position.z=z.s>0?D.T+0.015:-0.015; gZones.add(m);
}

// Component bodies.
const gParts=new THREE.Group(); scene.add(gParts);
const mats={conn:new THREE.MeshStandardMaterial({color:0xcfc9b8,roughness:0.6}),
 hdr:new THREE.MeshStandardMaterial({color:0x222226,roughness:0.6}),
 ant:new THREE.MeshStandardMaterial({color:0xb03030,roughness:0.5}),
 part:new THREE.MeshStandardMaterial({color:0x3a3d45,roughness:0.55})};
for(const c of D.comps){
  const w=c.x1-c.x0,h=c.y1-c.y0; if(w<=0||h<=0) continue;
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,c.h),mats[c.k]||mats.part);
  const z=c.side==='bottom'? -0.06-c.h/2 : D.T+0.06+c.h/2;
  m.position.set((c.x0+c.x1)/2,(c.y0+c.y1)/2,z);
  gParts.add(m);
}

// Silkscreen (footprint items + board lines).
const gSilk=new THREE.Group(); scene.add(gSilk);
{
  const top=[],bot=[];
  for(const s of D.silk){ (s[4]>0?top:bot).push(s); }
  for(const [arr,z,col] of [[top,D.T+0.08,0xf2eda1],[bot,-0.08,0xe8b2a7]]){
    if(!arr.length) continue;
    const verts=[];
    for(const s of arr) verts.push(s[0],s[1],z,s[2],s[3],z);
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
    gSilk.add(new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:col})));
  }
}

// Refdes labels as sprites (off by default).
const gLabels=new THREE.Group(); gLabels.visible=false; scene.add(gLabels);
for(const [r,x,y,side] of D.labels){
  const cv=document.createElement('canvas'); cv.width=128; cv.height=40;
  const c2=cv.getContext('2d');
  c2.font='bold 26px monospace'; c2.textAlign='center'; c2.textBaseline='middle';
  c2.fillStyle='#fff'; c2.strokeStyle='#000'; c2.lineWidth=5;
  c2.strokeText(r,64,20); c2.fillText(r,64,20);
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),depthTest:false}));
  sp.scale.set(6,1.9,1);
  sp.position.set(x,y,side>0?D.T+3.4:-3.4);
  gLabels.add(sp);
}

// Keepouts.
for(const k of D.keepouts){
  const xs=k.map(p=>p[0]),ys=k.map(p=>p[1]);
  const w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
  if(w<=0||h<=0) continue;
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),
    new THREE.MeshBasicMaterial({color:0xff8830,transparent:true,opacity:0.12,side:THREE.DoubleSide}));
  m.position.set(Math.min(...xs)+w/2,Math.min(...ys)+h/2,D.T+0.02); scene.add(m);
}

for(const [id,grp] of [['tParts',gParts],['tPads',gPads],['tTracks',gTracks],['tZones',gZones],['tSilk',gSilk],['tLabels',gLabels]]){
  const cb=document.getElementById(id);
  grp.visible=cb.checked;
  cb.addEventListener('change',()=>{grp.visible=cb.checked});
}
addEventListener('resize',()=>{cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix();ren.setSize(innerWidth,innerHeight)});
(function loop(){requestAnimationFrame(loop);ctl.update();ren.render(scene,cam)})();
</script></body></html>`;
}
