/**
 * Flamingo Engine - schematic types
 *
 * A Flamingo board has no drawn schematic: the netlist lives on the board
 * (`board.nets`). The schematic is generated from it, for documentation.
 *
 * Schematic space is the EasyEDA symbol space: 10 units = 0.1 inch, y DOWN
 * (SVG convention), unlike the board, which is millimetres with y up.
 */

/** A drawing primitive of a symbol body, in symbol-local coordinates. */
export type SymbolShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx?: number; filled?: boolean }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; filled?: boolean }
  | { kind: 'polyline'; points: number[]; closed?: boolean; filled?: boolean }
  | { kind: 'path'; d: string; filled?: boolean }
  | { kind: 'text'; x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end'; size: number; rotation: number };

/** Where a pin's name or number is written, as the symbol's author placed it. */
export interface SymbolPinText {
  x: number;
  y: number;
  rotation: number;
  anchor: 'start' | 'middle' | 'end';
  visible: boolean;
}

export interface SymbolPin {
  /** Pin number; matches a footprint pad number (`REFDES.<number>`). */
  number: string;
  name: string;
  /** The connection point: the pin's outer end, where a wire attaches. */
  at: { x: number; y: number };
  /** Direction from the body out to the connection point. */
  dir: 'left' | 'right' | 'up' | 'down';
  /** Length of the pin line, from the connection point back to the body. */
  length: number;
  nameText?: SymbolPinText;
  numberText?: SymbolPinText;
  /** Inverted-pin circle at the body end. */
  dot?: { x: number; y: number };
  /** Clock wedge at the body end, an SVG path. */
  clock?: string;
}

export interface SchematicSymbol {
  shapes: SymbolShape[];
  pins: SymbolPin[];
  /** Bounds of the body shapes and the pin lines (not of the pin texts). */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** A drawing primitive of the finished sheet, in sheet coordinates. */
export type SchematicPrim =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; cls: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; cls: string; rx?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; cls: string }
  | { t: 'text'; x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; cls: string; rotation?: number }
  | {
      t: 'symbol';
      symbol: SchematicSymbol;
      /** Sheet position of the symbol-local point (cx, cy). */
      x: number;
      y: number;
      cx: number;
      cy: number;
      /** Quarter turns clockwise on the sheet. */
      turns: 0 | 1 | 2 | 3;
      /** Draw pin names/numbers and body texts (off for small two-pin parts). */
      texts: boolean;
      refdes: string;
    };

/** How one component pin is shown. Every pad on a net appears exactly once. */
export interface SchematicPin {
  /** `REFDES.PAD` */
  pin: string;
  net: string | null;
  /**
   * `wire`: joined to the other pins of its net by a drawn wire (the wire also
   * carries the net name). `label`: a net label. `ground` / `rail`: a power
   * symbol. `nc`: on no net, marked with a cross.
   */
  shown: 'wire' | 'label' | 'ground' | 'rail' | 'nc';
}

export interface Schematic {
  /** Sheet size in schematic units (10 units = 2.54 mm). */
  width: number;
  height: number;
  prims: SchematicPrim[];
  pins: SchematicPin[];
  /** Components drawn with a generic box because no usable symbol was given. */
  generic: string[];
}
