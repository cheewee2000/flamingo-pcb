/**
 * Flamingo Engine - schematic SVG renderer
 *
 * Turns a built `Schematic` into one self-contained SVG. Sized in
 * millimetres at true schematic scale (10 units = 2.54 mm), so it prints at
 * the size a drawn schematic would.
 */

import type { Schematic, SchematicPrim, SchematicSymbol, SymbolPin, SymbolPinText } from './types.js';
import { pinInner } from './symbol.js';

const UNIT_MM = 0.254;
const PIN_FONT = 7;

const STYLE = `
.paper{fill:#fff}
.border{fill:none;stroke:#9aa1ab;stroke-width:.6}
.frame{fill:#fafbfc;stroke:#c9ced6;stroke-width:.5;stroke-dasharray:3 2}
.wire{stroke:#0a7a32;stroke-width:1;stroke-linecap:round}
.dot{fill:#0a7a32}
.nc{stroke:#5b6470;stroke-width:.8;stroke-linecap:round}
.power{stroke:#b3261e;stroke-width:1.2;stroke-linecap:round}
.body{fill:none;stroke:#8a1c1c;stroke-width:1;stroke-linejoin:round;stroke-linecap:round}
.body-box{fill:#fff8dc;stroke:#8a1c1c;stroke-width:1;stroke-linejoin:round}
.body-fill{fill:#8a1c1c;stroke:#8a1c1c;stroke-width:1;stroke-linejoin:round}
.pin{stroke:#8a1c1c;stroke-width:1;stroke-linecap:round}
.pin-dot{fill:#fff;stroke:#8a1c1c;stroke-width:1}
text{font-family:Helvetica,Arial,'Liberation Sans','DejaVu Sans',sans-serif}
.pin-name{fill:#1f2933}
.pin-num{fill:#7b8794}
.sym-text{fill:#3e4c59}
.net{fill:#0b3d91}
.power-text{fill:#b3261e;font-weight:600}
.ref{fill:#1f2933;font-weight:600}
.value{fill:#52606d}
.caption{fill:#102a43;font-weight:700}
.note{fill:#627d98}
.title{fill:#102a43;font-weight:700}
`.trim();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function pinText(pin: SymbolPin, t: SymbolPinText | undefined, text: string, cls: string, dx: number, dy: number): string {
  if (!t || !t.visible || text === '') return '';
  const x = t.x + dx;
  const y = t.y + dy;
  // EasyEDA turns the text of vertical pins; anything not upright reads bottom to top.
  const turned = Math.abs(((t.rotation % 180) + 180) % 180 - 90) < 1;
  const rot = turned ? ` transform="rotate(-90 ${n(x)} ${n(y)})"` : '';
  return `<text x="${n(x)}" y="${n(y)}" font-size="${PIN_FONT}" text-anchor="${t.anchor}" class="${cls}"${rot}>${esc(text)}</text>`;
}

function symbolBody(sym: SchematicSymbol): string {
  const out: string[] = [];
  // Filled body boxes go first so nothing drawn before them in the library is hidden.
  const ordered = [...sym.shapes.filter((s) => s.kind === 'rect'), ...sym.shapes.filter((s) => s.kind !== 'rect')];
  for (const s of ordered) {
    const cls = s.kind !== 'text' && s.filled ? 'body-fill' : 'body';
    if (s.kind === 'rect') {
      out.push(`<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}"${s.rx ? ` rx="${n(s.rx)}"` : ''} class="body-box"/>`);
    } else if (s.kind === 'ellipse') {
      out.push(`<ellipse cx="${n(s.cx)}" cy="${n(s.cy)}" rx="${n(s.rx)}" ry="${n(s.ry)}" class="${cls}"/>`);
    } else if (s.kind === 'polyline') {
      const tag = s.closed ? 'polygon' : 'polyline';
      out.push(`<${tag} points="${s.points.map(n).join(' ')}" class="${cls}"/>`);
    } else if (s.kind === 'path') {
      out.push(`<path d="${esc(s.d)}" class="${cls}"/>`);
    }
  }
  for (const p of sym.pins) {
    const inner = pinInner(p);
    out.push(`<line x1="${n(p.at.x)}" y1="${n(p.at.y)}" x2="${n(inner.x)}" y2="${n(inner.y)}" class="pin"/>`);
    if (p.dot) out.push(`<circle cx="${n(p.dot.x)}" cy="${n(p.dot.y)}" r="3" class="pin-dot"/>`);
    if (p.clock) out.push(`<path d="${esc(p.clock)}" class="body"/>`);
  }
  return out.join('');
}

function symbolTexts(sym: SchematicSymbol, dx: number, dy: number): string {
  const out: string[] = [];
  for (const s of sym.shapes) {
    if (s.kind !== 'text') continue;
    out.push(`<text x="${n(s.x + dx)}" y="${n(s.y + dy)}" font-size="${n(s.size)}" text-anchor="${s.anchor}" class="sym-text">${esc(s.text)}</text>`);
  }
  for (const p of sym.pins) {
    out.push(pinText(p, p.nameText, p.name, 'pin-name', dx, dy));
    if (p.number !== p.name) out.push(pinText(p, p.numberText, p.number, 'pin-num', dx, dy));
  }
  return out.join('');
}

function prim(p: SchematicPrim): string {
  switch (p.t) {
    case 'line':
      return `<line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}" class="${p.cls}"/>`;
    case 'rect':
      return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"${p.rx ? ` rx="${n(p.rx)}"` : ''} class="${p.cls}"/>`;
    case 'circle':
      return `<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}" class="${p.cls}"/>`;
    case 'text': {
      const rot = p.rotation ? ` transform="rotate(${n(p.rotation)} ${n(p.x)} ${n(p.y)})"` : '';
      return `<text x="${n(p.x)}" y="${n(p.y)}" font-size="${n(p.size)}" text-anchor="${p.anchor}" class="${p.cls}"${rot}>${esc(p.text)}</text>`;
    }
    case 'symbol': {
      const move = `translate(${n(p.x)} ${n(p.y)})${p.turns ? ` rotate(${p.turns * 90})` : ''} translate(${n(-p.cx)} ${n(-p.cy)})`;
      const body = `<g transform="${move}" data-ref="${esc(p.refdes)}">${symbolBody(p.symbol)}</g>`;
      // Texts are drawn outside the turned group so they always stay upright.
      return p.texts && p.turns === 0 ? body + symbolTexts(p.symbol, p.x - p.cx, p.y - p.cy) : body;
    }
  }
}

export function renderSchematicSVG(sch: Schematic): string {
  const w = n(sch.width * UNIT_MM);
  const h = n(sch.height * UNIT_MM);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${n(sch.width)} ${n(sch.height)}">` +
    `<style>${STYLE}</style>` +
    sch.prims.map(prim).join('') +
    `</svg>\n`
  );
}
