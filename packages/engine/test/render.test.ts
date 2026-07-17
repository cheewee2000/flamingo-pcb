import { describe, it, expect } from 'vitest';
import { renderSVG } from '../src/index.js';
import { newBoard } from '../src/index.js';
import type { Board, Footprint, ComponentInst, Pad } from '../src/index.js';

function makeFootprint(overrides: Partial<Footprint> = {}): Footprint {
  return {
    name: 'test-fp',
    lcsc: 'C0',
    pads: [
      { number: '1', shape: 'rect', at: { x: -1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
      { number: '2', shape: 'rect', at: { x: 1, y: 0 }, rotation: 0, size: { w: 1, h: 1 }, layer: 'top' },
    ],
    silk: [{ kind: 'line', start: { x: -1.5, y: 1 }, end: { x: 1.5, y: 1 }, width: 0.15 }],
    courtyard: [],
    ...overrides,
  };
}

function makeComponent(overrides: Partial<ComponentInst> = {}): ComponentInst {
  return {
    refdes: 'R1',
    lcsc: 'C0',
    footprint: makeFootprint(),
    at: { x: 10, y: 12 },
    rotation: 0,
    side: 'top',
    fields: {},
    ...overrides,
  };
}

/** A tiny 2-layer board: 20x20 outline, 1 component w/ 2 rect pads, 1 track, 1 via. */
function tinyBoard(): Board {
  const b = newBoard('tiny', 2);
  b.outline = [
    { type: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
    { type: 'line', start: { x: 20, y: 0 }, end: { x: 20, y: 20 } },
    { type: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 } },
    { type: 'line', start: { x: 0, y: 20 }, end: { x: 0, y: 0 } },
  ];
  b.components = [makeComponent()];
  b.nets = [{ name: 'NET1', class: 'default', pins: ['R1.1', 'R1.2'] }];
  b.tracks = [
    { id: 'T1', layer: 'F.Cu', width: 0.25, net: 'NET1', seg: { type: 'line', start: { x: 9, y: 12 }, end: { x: 5, y: 12 } } },
  ];
  b.vias = [{ id: 'V1', at: { x: 5, y: 12 }, drill: 0.3, diameter: 0.6, net: 'NET1' }];
  return b;
}

/** A fuller fixture touching every renderer feature, for the full-SVG snapshot. */
function fixtureBoard(): Board {
  const b = tinyBoard();
  b.zones = [
    {
      id: 'Z1',
      layer: 'B.Cu',
      net: 'GND',
      polygon: [
        { x: 2, y: 2 },
        { x: 18, y: 2 },
        { x: 18, y: 18 },
        { x: 2, y: 18 },
      ],
      clearance: 0.2,
      minWidth: 0.2,
      thermal: { gap: 0.5, spokeWidth: 0.25 },
    },
  ];
  b.keepouts = [
    {
      id: 'K1',
      layers: 'all',
      polygon: [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 3 },
        { x: 0, y: 3 },
      ],
      keepout: { copper: true, via: true },
    },
  ];
  b.holes = [{ id: 'H1', at: { x: 1, y: 19 }, drill: 0.8, padDiameter: 1.6, plated: true }];
  b.silk = [{ id: 'S1', layer: 'F.Silk', at: { x: 10, y: 5 }, text: 'FLAMINGO', height: 1, rotation: 0 }];
  return b;
}

describe('renderSVG - tiny board elements', () => {
  const svg = renderSVG(tinyBoard());

  it('is a well-formed <svg> string', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
  });

  it('contains F.Cu color for the top-side rect pads and track', () => {
    expect(svg).toContain('#C83434');
  });

  it('contains the through-pad-color-free rect pad polygons (SMD, no drill)', () => {
    // rect pads on 'top' layer are SMD, not through -- no #222 drill circle expected for them alone
    // (but a via IS present, so #222 should appear from the via drill)
    expect(svg).toContain('#222');
  });

  it('contains the via ring color', () => {
    expect(svg).toContain('#B8B85A');
  });

  it('contains the Edge outline color', () => {
    expect(svg).toContain('#D0D2CD');
  });

  it('contains F.Silk color for the footprint silk line and refdes label', () => {
    expect(svg).toContain('#F2EDA1');
    expect(svg).toContain('>R1<');
  });

  it('renders the track as a path with the correct stroke-width', () => {
    expect(svg).toContain('stroke-width="0.2500"');
  });

  it('renders 2 pad polygons for the component', () => {
    const matches = svg.match(/<polygon points="[^"]*" fill="#C83434"\/>/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('respects opts.layers filtering (excluding F.Cu removes pad/track color)', () => {
    const filtered = renderSVG(tinyBoard(), { layers: ['B.Cu', 'Edge'] });
    expect(filtered).not.toContain('#C83434');
    expect(filtered).toContain('#D0D2CD');
  });

  it('sets width from widthPx (default 1200)', () => {
    expect(svg).toContain('width="1200.0000"');
    const custom = renderSVG(tinyBoard(), { widthPx: 600 });
    expect(custom).toContain('width="600.0000"');
  });
});

describe('renderSVG - region crop', () => {
  it('sets viewBox from opts.region with a 2mm margin', () => {
    const svg = renderSVG(tinyBoard(), { region: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });
    expect(svg).toContain('viewBox="-2.0000 -2.0000 14.0000 14.0000"');
  });

  it('falls back to board bbox with a 2mm margin when no region given', () => {
    const svg = renderSVG(tinyBoard());
    // outline is 0,0 to 20,20 -> bbox with 2mm margin -> viewBox -2 -2 24 24
    expect(svg).toContain('viewBox="-2.0000 -2.0000 24.0000 24.0000"');
  });
});

describe('renderSVG - ratsnest', () => {
  it('omits ratsnest lines when none passed', () => {
    const svg = renderSVG(tinyBoard());
    expect(svg).not.toContain('#ffffff66');
  });

  it('renders dashed ratsnest lines when passed', () => {
    const svg = renderSVG(tinyBoard(), {
      ratsnest: [{ net: 'NET1', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }],
    });
    expect(svg).toContain('#ffffff66');
    expect(svg).toContain('stroke-dasharray');
  });

  it('suppresses ratsnest lines when showRatsnest is false, even if passed', () => {
    const svg = renderSVG(tinyBoard(), {
      ratsnest: [{ net: 'NET1', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }],
      showRatsnest: false,
    });
    expect(svg).not.toContain('#ffffff66');
  });
});

describe('renderSVG - highlight overlay', () => {
  it('adds a cyan overlay for tracks/vias/pads on the highlighted net', () => {
    const svg = renderSVG(tinyBoard(), { highlightNet: 'NET1' });
    expect(svg).toContain('#00FFFF');
    // track width 0.25 + 0.1 = 0.35
    expect(svg).toContain('stroke-width="0.3500"');
  });

  it('omits the overlay when no net matches', () => {
    const svg = renderSVG(tinyBoard(), { highlightNet: 'NOPE' });
    expect(svg).not.toContain('#00FFFF');
  });
});

describe('renderSVG - DRC markers', () => {
  it('renders unfilled red circles at each marker point', () => {
    const svg = renderSVG(tinyBoard(), { drcMarkers: [{ x: 5, y: 5 }] });
    expect(svg).toContain('#FF0000');
    expect(svg).toContain('r="0.5000"');
    expect(svg).toContain('stroke-width="0.15"');
  });

  it('omits DRC markers when none given', () => {
    const svg = renderSVG(tinyBoard());
    expect(svg).not.toContain('#FF0000');
  });
});

describe('renderSVG - arc rendering (tracks)', () => {
  /**
   * Arc centered at (5,5), radius 3: start=(8,5) is at angle 0 rad;
   * end=(5,8) is at angle pi/2 rad (90deg), both relative to center.
   * (render.ts arcPathD computes a0/a1 via atan2 on the *world* start/end
   * relative to center -- these are the world points directly, no component
   * transform involved for a board-level track.)
   */
  function arcTrackBoard(cw: boolean): Board {
    const b = newBoard('arc-track', 2);
    b.tracks = [
      {
        id: 'TA',
        layer: 'F.Cu',
        width: 0.2,
        net: 'NET1',
        seg: { type: 'arc', start: { x: 8, y: 5 }, end: { x: 5, y: 8 }, center: { x: 5, y: 5 }, cw },
      },
    ];
    return b;
  }

  it('cw:false -> sweep = a1-a0 = pi/2 (90deg) < pi => largeArc=0, sweepFlag=0', () => {
    // sweep = ((a1 - a0) mod 2pi) = pi/2 - 0 = pi/2 (90deg) < pi -> largeArc = 0
    // sweepFlag = cw ? 1 : 0 = 0
    const svg = renderSVG(arcTrackBoard(false));
    expect(svg).toContain('A 3.0000 3.0000 0 0 0');
  });

  it('cw:true -> sweep = a0-a1 = 3pi/2 (270deg) > pi => largeArc=1, sweepFlag=1', () => {
    // sweep = ((a0 - a1) mod 2pi) = (0 - pi/2 + 2pi) mod 2pi = 3pi/2 (270deg) > pi -> largeArc = 1
    // sweepFlag = cw ? 1 : 0 = 1
    const svg = renderSVG(arcTrackBoard(true));
    expect(svg).toContain('A 3.0000 3.0000 0 1 1');
  });
});

describe('renderSVG - arc rendering (footprint silk, mirror)', () => {
  /**
   * Silk arc defined in footprint-local space: start=(1,0), end=(0,1),
   * center=(0,0), cw=false. Component placed at (10,10), rotation 0.
   *
   * Top side (mirror=false): world points are unchanged by the mirror step,
   * just translated by (10,10) -> start=(11,10), end=(10,11), center=(10,10).
   * effectiveCw = mirror ? !cw : cw = false.
   * a0 = atan2(0,1) = 0; a1 = atan2(1,0) = pi/2.
   * sweep (effectiveCw=false) = (a1-a0) mod 2pi = pi/2 < pi -> largeArc=0.
   * sweepFlag = effectiveCw ? 1 : 0 = 0.
   *
   * Bottom side (mirror=true): local points get x -> -x before translate:
   * start (1,0) -> (-1,0) -> world (9,10); end (0,1) -> (0,1) -> world (10,11);
   * center (0,0) -> (0,0) -> world (10,10).
   * effectiveCw = mirror ? !cw : cw = !false = true.
   * a0 = atan2(10-10, 9-10) = atan2(0,-1) = pi; a1 = atan2(11-10,10-10) = pi/2.
   * sweep (effectiveCw=true) = (a0-a1) mod 2pi = pi/2 < pi -> largeArc=0.
   * sweepFlag = effectiveCw ? 1 : 0 = 1.
   *
   * So largeArc is 0 on both sides (same magnitude sweep), but sweepFlag
   * flips 0 -> 1, confirming effectiveCw = mirror ? !cw : cw.
   */
  function silkArcBoard(side: 'top' | 'bottom'): Board {
    const b = newBoard('silk-arc', 2);
    b.components = [
      makeComponent({
        side,
        at: { x: 10, y: 10 },
        rotation: 0,
        footprint: makeFootprint({
          silk: [{ kind: 'arc', start: { x: 1, y: 0 }, end: { x: 0, y: 1 }, center: { x: 0, y: 0 }, cw: false, width: 0.1 }],
        }),
      }),
    ];
    return b;
  }

  it('top-side component renders the silk arc with sweepFlag=0', () => {
    const svg = renderSVG(silkArcBoard('top'));
    expect(svg).toContain('A 1.0000 1.0000 0 0 0');
  });

  it('bottom-side component renders the same silk arc with the sweepFlag inverted (1)', () => {
    const svg = renderSVG(silkArcBoard('bottom'));
    expect(svg).toContain('A 1.0000 1.0000 0 0 1');
  });
});

describe('renderSVG - slotted mounting hole', () => {
  it('draws a plated slot as annulus + drill stadium polygons, not circles', () => {
    const b = newBoard('slot', 2);
    b.holes = [{ id: 'H1', at: { x: 5, y: 5 }, drill: 1, padDiameter: 2, plated: true, slotLength: 6 }];
    const svg = renderSVG(b);
    // Annulus stadium (through-pad color) and drill stadium (hole color) as polygons.
    expect(svg).toMatch(/<polygon points="[^"]*" fill="#B8B85A"\/>/);
    expect(svg).toMatch(/<polygon points="[^"]*" fill="#222"\/>/);
    // No round hole circle for this slot (a round plated hole would emit circles).
    expect(svg).not.toContain('<circle');
  });

  it('draws an unplated slot as a stroked stadium outline', () => {
    const b = newBoard('slot', 2);
    b.holes = [{ id: 'H1', at: { x: 5, y: 5 }, drill: 1, padDiameter: 1, plated: false, slotLength: 6 }];
    const svg = renderSVG(b);
    expect(svg).toMatch(/<polygon points="[^"]*" fill="none" stroke="#D0D2CD" stroke-width="0.1"\/>/);
  });
});

describe('renderSVG - full fixture snapshot', () => {
  it('matches the recorded SVG for the fixture board', () => {
    const svg = renderSVG(fixtureBoard());
    expect(svg).toMatchInlineSnapshot(`"<svg xmlns="http://www.w3.org/2000/svg" width="1200.0000" height="1200.0000" viewBox="-2.0000 -2.0000 24.0000 24.0000"><rect x="-2.0000" y="-2.0000" width="24.0000" height="24.0000" fill="#1a1a1a"/><defs><pattern id="keepout-hatch" patternUnits="userSpaceOnUse" width="1" height="1" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1" stroke="#FF6600" stroke-width="0.2"/></pattern></defs><polygon points="2.0000,18.0000 18.0000,18.0000 18.0000,2.0000 2.0000,2.0000" fill="#4D7FC4" fill-opacity="0.25" stroke="none"/><path d="M 9.0000 8.0000 L 5.0000 8.0000" stroke="#C83434" stroke-width="0.2500" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polygon points="8.5000,8.5000 9.5000,8.5000 9.5000,7.5000 8.5000,7.5000" fill="#C83434"/><polygon points="10.5000,8.5000 11.5000,8.5000 11.5000,7.5000 10.5000,7.5000" fill="#C83434"/><circle cx="5.0000" cy="8.0000" r="0.3000" fill="#B8B85A"/><circle cx="5.0000" cy="8.0000" r="0.1500" fill="#222"/><circle cx="1.0000" cy="1.0000" r="0.8000" fill="#B8B85A"/><circle cx="1.0000" cy="1.0000" r="0.4000" fill="#222"/><line x1="8.5000" y1="7.0000" x2="11.5000" y2="7.0000" stroke="#F2EDA1" stroke-width="0.1500" stroke-linecap="round"/><text x="10.0000" y="8.0000" font-family="monospace" font-size="1.0000" text-anchor="middle" fill="#F2EDA1">R1</text><text x="10.0000" y="15.0000" font-family="monospace" font-size="1.0000" text-anchor="middle" fill="#F2EDA1">FLAMINGO</text><polygon points="0.0000,20.0000 20.0000,20.0000 20.0000,0.0000 0.0000,0.0000" fill="none" stroke="#D0D2CD" stroke-width="0.1"/><polygon points="0.0000,20.0000 3.0000,20.0000 3.0000,17.0000 0.0000,17.0000" fill="url(#keepout-hatch)" fill-opacity="0.6" stroke="#FF6600" stroke-width="0.1"/></svg>"`);
  });
});
