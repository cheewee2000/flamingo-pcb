/**
 * Server-generated interactive 3D board viewer.
 *
 * GET /3d renders the current in-memory board into a self-contained HTML page
 * (three.js from CDN) so placement can be reviewed in 3D at any time. The
 * geometry is regenerated from the live board on every request.
 *
 * Component bodies are extruded courtyard bounding boxes with per-package
 * height heuristics -- a review aid, not a mechanical model.
 */

import type { Board, ComponentInst } from '@flamingo/engine';

function componentHeight(c: ComponentInst): number {
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

interface Viewer3dData {
  name: string;
  T: number;
  outline: Board['outline'];
  holes: { x: number; y: number; d: number; slot: number; rot: number }[];
  comps: { r: string; x0: number; y0: number; x1: number; y1: number; h: number; k: string; side: string }[];
  pads: [number, number, number, number, number][]; // x0,y0,w,h, side(1 top / -1 bottom)
  keepouts: [number, number][][];
  silkLines: { a: [number, number]; b: [number, number]; back: boolean }[];
}

function extractData(board: Board): Viewer3dData {
  const comps: Viewer3dData['comps'] = [];
  const pads: Viewer3dData['pads'] = [];
  for (const c of board.components) {
    const rot = ((c.rotation ?? 0) * Math.PI) / 180;
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    const pts: { x: number; y: number }[] = [];
    for (const poly of c.footprint.courtyard ?? []) for (const p of poly) pts.push(p);
    if (pts.length === 0) {
      for (const p of c.footprint.pads) {
        for (const dx of [-p.size.w / 2, p.size.w / 2])
          for (const dy of [-p.size.h / 2, p.size.h / 2]) pts.push({ x: p.at.x + dx, y: p.at.y + dy });
      }
    }
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of pts) {
      const x = c.at.x + p.x * ca - p.y * sa;
      const y = c.at.y + p.x * sa + p.y * ca;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (!isFinite(x0)) continue;
    const kind = /^(J|H)/.test(c.refdes) ? (c.refdes.startsWith('H') ? 'hdr' : 'conn') : c.refdes === 'ANT1' ? 'ant' : 'part';
    comps.push({
      r: c.refdes,
      x0: +x0.toFixed(2),
      y0: +y0.toFixed(2),
      x1: +x1.toFixed(2),
      y1: +y1.toFixed(2),
      h: componentHeight(c),
      k: kind,
      side: c.side,
    });
    const sideSign = c.side === 'bottom' ? -1 : 1;
    for (const p of c.footprint.pads) {
      const X = c.at.x + p.at.x * ca - p.at.y * sa;
      const Y = c.at.y + p.at.x * sa + p.at.y * ca;
      let w = p.size.w,
        h = p.size.h;
      if (Math.abs(sa) > 0.5) [w, h] = [h, w];
      pads.push([+(X - w / 2).toFixed(2), +(Y - h / 2).toFixed(2), +w.toFixed(2), +h.toFixed(2), sideSign]);
    }
  }
  return {
    name: board.name,
    T: 1.6,
    outline: board.outline,
    holes: board.holes.map((h) => ({
      x: h.at.x,
      y: h.at.y,
      d: h.drill,
      slot: h.slotLength ?? 0,
      rot: h.rotation ?? 0,
    })),
    comps,
    pads,
    keepouts: board.keepouts.map((k) => k.polygon.map((p) => [p.x, p.y] as [number, number])),
    silkLines: board.silkLines.map((s) => ({
      a: [s.start.x, s.start.y],
      b: [s.end.x, s.end.y],
      back: s.layer === 'B.Silk',
    })),
  };
}

export function render3dHtml(board: Board): string {
  const data = JSON.stringify(extractData(board));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${board.name} 3D</title>
<style>body{margin:0;background:#14161a;color:#ccc;font:12px monospace}#hud{position:fixed;top:8px;left:10px;z-index:2}</style>
</head><body>
<div id="hud">${board.name} 3D · drag = orbit · wheel = zoom · shift-drag = pan · <a href="/" style="color:#8ac">back to editor</a></div>
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
scene.add(new THREE.AmbientLight(0xffffff,0.55));
const dl=new THREE.DirectionalLight(0xffffff,1.1); dl.position.set(60,-80,120); scene.add(dl);
const dl2=new THREE.DirectionalLight(0x8899ff,0.4); dl2.position.set(-40,60,-80); scene.add(dl2);
function segAngles(s){
  const a0=Math.atan2(s.start.y-s.center.y,s.start.x-s.center.x);
  const a1=Math.atan2(s.end.y-s.center.y,s.end.x-s.center.x);
  return [a0,a1];
}
const sh=new THREE.Shape();
D.outline.forEach((s,i)=>{
  if(i===0) sh.moveTo(s.start.x,s.start.y);
  if(s.type==='line') sh.lineTo(s.end.x,s.end.y);
  else { const r=Math.hypot(s.start.x-s.center.x,s.start.y-s.center.y);
    const [a0,a1]=segAngles(s); sh.absarc(s.center.x,s.center.y,r,a0,a1,s.cw); }
});
for(const h of D.holes){
  const p=new THREE.Path();
  const rot=(h.rot||0)*Math.PI/180, ca=Math.cos(rot), sa=Math.sin(rot);
  if(h.slot>h.d){const L=h.slot/2-h.d/2;
    const c1={x:h.x-L*ca,y:h.y-L*sa}, c2={x:h.x+L*ca,y:h.y+L*sa};
    p.absarc(c2.x,c2.y,h.d/2,rot-Math.PI/2,rot+Math.PI/2,false);
    p.absarc(c1.x,c1.y,h.d/2,rot+Math.PI/2,rot+1.5*Math.PI,false);
  } else p.absarc(h.x,h.y,h.d/2,0,2*Math.PI,false);
  sh.holes.push(p);
}
const board=new THREE.Mesh(new THREE.ExtrudeGeometry(sh,{depth:D.T,bevelEnabled:false}),
  new THREE.MeshStandardMaterial({color:0x4a2340,roughness:0.7,metalness:0.1}));
scene.add(board);
const padMat=new THREE.MeshStandardMaterial({color:0xd8b545,roughness:0.35,metalness:0.85});
const padInst=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,0.06),padMat,D.pads.length);
const m4=new THREE.Matrix4();
D.pads.forEach((p,i)=>{ m4.makeScale(p[2],p[3],1);
  m4.setPosition(p[0]+p[2]/2,p[1]+p[3]/2,p[4]>0?D.T+0.03:-0.03); padInst.setMatrixAt(i,m4); });
scene.add(padInst);
const mats={conn:new THREE.MeshStandardMaterial({color:0xcfc9b8,roughness:0.6}),
 hdr:new THREE.MeshStandardMaterial({color:0x222226,roughness:0.6}),
 ant:new THREE.MeshStandardMaterial({color:0xb03030,roughness:0.5}),
 part:new THREE.MeshStandardMaterial({color:0x3a3d45,roughness:0.55})};
for(const c of D.comps){
  const w=c.x1-c.x0,h=c.y1-c.y0; if(w<=0||h<=0) continue;
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,c.h),mats[c.k]||mats.part);
  const z=c.side==='bottom'? -0.06-c.h/2 : D.T+0.06+c.h/2;
  m.position.set((c.x0+c.x1)/2,(c.y0+c.y1)/2,z);
  scene.add(m);
}
const silkMat=new THREE.LineBasicMaterial({color:0xdddddd});
const sgeo=new THREE.BufferGeometry(); const verts=[];
for(const s of D.silkLines){ const z=s.back? -0.1 : D.T+0.1;
  verts.push(s.a[0],s.a[1],z,s.b[0],s.b[1],z); }
sgeo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
scene.add(new THREE.LineSegments(sgeo,silkMat));
for(const k of D.keepouts){
  const xs=k.map(p=>p[0]),ys=k.map(p=>p[1]);
  const w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
  if(w<=0||h<=0) continue;
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),
    new THREE.MeshBasicMaterial({color:0xff8830,transparent:true,opacity:0.15,side:THREE.DoubleSide}));
  m.position.set(Math.min(...xs)+w/2,Math.min(...ys)+h/2,D.T+0.02); scene.add(m);
}
addEventListener('resize',()=>{cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix();ren.setSize(innerWidth,innerHeight)});
(function loop(){requestAnimationFrame(loop);ctl.update();ren.render(scene,cam)})();
</script></body></html>`;
}
