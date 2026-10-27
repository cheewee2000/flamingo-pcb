/**
 * The two boards the panel end-to-end script builds, as data.
 *
 * `ESP32` is the reference board of e2e-esp32.ts, part for part and net for
 * net (that script keeps its own copy and is not touched). `BREAKOUT` is a
 * small 2-layer USB-C power breakout whose connector hangs over the board
 * edge, so the panel has a blocked edge to deal with.
 */

export interface Place {
  refdes: string;
  lcsc: string;
  x: number;
  y: number;
  rotation?: number;
  value?: string;
  role?: string;
}

export interface NetClassSpec {
  name: string;
  trackWidth: number;
  clearance: number;
  viaDrill: number;
  viaDiameter: number;
  nets: string[];
}

export interface BoardSpec {
  name: string;
  copperLayers: 2 | 4 | 6;
  width: number;
  height: number;
  cornerRadius: number;
  placements: Place[];
  nets: Record<string, string[]>;
  classes: NetClassSpec[];
  /** GND pour on F.Cu and B.Cu, as an inset from the outline. */
  pourInset: number;
  holes: Array<[x: number, y: number]>;
  silk?: { x: number; y: number; text: string; height: number };
}

const PART = {
  esp32: 'C2913204', // ESP32-S3-WROOM-1-N8R2 module
  usbc: 'C165948', // TYPE-C-31-M-12 USB-C 16-pin
  ldo: 'C6186', // AMS1117-3.3 SOT-223
  r10k: 'C25804', // 10k 0603
  r5k1: 'C23186', // 5.1k 0603
  c10u: 'C15850', // 10uF 0805
  c100n: 'C605211', // 100nF 0603
} as const;

export const ESP32: BoardSpec = {
  name: 'esp32-breakout',
  copperLayers: 2,
  width: 40,
  height: 30,
  cornerRadius: 2,
  placements: [
    { refdes: 'U1', lcsc: PART.esp32, x: 25, y: 12, value: 'ESP32-S3-WROOM-1' },
    { refdes: 'J1', lcsc: PART.usbc, x: 8, y: 22, value: 'USB-C' },
    { refdes: 'U2', lcsc: PART.ldo, x: 8, y: 12, value: 'AMS1117-3.3' },
    { refdes: 'C1', lcsc: PART.c10u, x: 6.5, y: 6.5, value: '10uF' },
    { refdes: 'C4', lcsc: PART.c100n, x: 10, y: 6.5, value: '100nF' },
    { refdes: 'R1', lcsc: PART.r10k, x: 6.5, y: 3, value: '10k' },
    { refdes: 'R2', lcsc: PART.r10k, x: 10, y: 3, value: '10k' },
    { refdes: 'C2', lcsc: PART.c100n, x: 37, y: 10, value: '100nF' },
    { refdes: 'C3', lcsc: PART.c10u, x: 37, y: 17, value: '10uF' },
  ],
  nets: {
    VBUS: ['J1.B4A9', 'J1.A4B9', 'U2.3', 'C1.1', 'C4.1'],
    '3V3': ['U2.2', 'U2.4', 'U1.2', 'C3.1', 'C2.1', 'R1.2', 'R2.2'],
    GND: [
      'J1.A1B12', 'J1.B1A12', 'J1.1', 'J1.2', 'J1.3', 'J1.4',
      'U2.1', 'U1.1', 'U1.40', 'U1.41', 'C1.2', 'C4.2', 'C3.2', 'C2.2',
    ],
    USB_DP: ['J1.A6', 'U1.14'],
    USB_DN: ['J1.A7', 'U1.13'],
    EN: ['U1.3', 'R1.1'],
    IO0: ['U1.27', 'R2.1'],
  },
  classes: [
    { name: 'power', trackWidth: 0.5, clearance: 0.15, viaDrill: 0.3, viaDiameter: 0.6, nets: ['VBUS', '3V3', 'GND'] },
    { name: 'signal', trackWidth: 0.25, clearance: 0.15, viaDrill: 0.3, viaDiameter: 0.6, nets: ['USB_DP', 'USB_DN', 'EN', 'IO0'] },
  ],
  pourInset: 2,
  holes: [[3, 3], [37, 3], [3, 27], [37, 27]],
  silk: { x: 20, y: 1.5, text: 'esp32-breakout v0.1.0', height: 1.2 },
};

/**
 * 22 x 16 mm. The USB-C connector sits on the left edge, turned so that its
 * shell points outward and overhangs the outline, as an edge-mounted connector
 * does. CC pull-downs make it a 5 V sink; a bulk and a bypass capacitor sit on
 * VBUS.
 */
export const BREAKOUT: BoardSpec = {
  name: 'usbc-breakout',
  copperLayers: 2,
  width: 22,
  height: 16,
  cornerRadius: 1,
  placements: [
    // Rotated 270 (CCW): the connector's mouth, which faces -y at rotation 0,
    // faces -x, off the left edge. Its lowest copper is 3.37 mm from its
    // origin and its courtyard 5.09 mm, so at x = 3.9 every pad clears the
    // edge by 0.5 mm and the shell overhangs it by 1.2 mm.
    { refdes: 'J1', lcsc: PART.usbc, x: 3.9, y: 8, rotation: 270, value: 'USB-C', role: 'Power input' },
    { refdes: 'R1', lcsc: PART.r5k1, x: 12, y: 12.5, value: '5.1k', role: 'CC1 pull-down' },
    { refdes: 'R2', lcsc: PART.r5k1, x: 12, y: 3.5, value: '5.1k', role: 'CC2 pull-down' },
    { refdes: 'C1', lcsc: PART.c10u, x: 17.5, y: 11, rotation: 90, value: '10uF', role: 'VBUS bulk' },
    { refdes: 'C2', lcsc: PART.c100n, x: 17.5, y: 5, rotation: 90, value: '100nF', role: 'VBUS bypass' },
  ],
  nets: {
    VBUS: ['J1.B4A9', 'J1.A4B9', 'C1.1', 'C2.1'],
    GND: ['J1.A1B12', 'J1.B1A12', 'J1.1', 'J1.2', 'J1.3', 'J1.4', 'R1.2', 'R2.2', 'C1.2', 'C2.2'],
    CC1: ['J1.A5', 'R1.1'],
    CC2: ['J1.B5', 'R2.1'],
  },
  classes: [
    { name: 'power', trackWidth: 0.4, clearance: 0.15, viaDrill: 0.3, viaDiameter: 0.6, nets: ['VBUS', 'GND'] },
    { name: 'signal', trackWidth: 0.25, clearance: 0.15, viaDrill: 0.3, viaDiameter: 0.6, nets: ['CC1', 'CC2'] },
  ],
  pourInset: 1,
  holes: [],
};
