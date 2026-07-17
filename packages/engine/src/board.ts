import type { Board, NetClass } from './types.js';

/**
 * Create a new board with default values.
 * @param name - Board name
 * @param copperLayers - Number of copper layers (2, 4, or 6)
 * @returns A new Board with sensible defaults
 */
export function newBoard(name: string, copperLayers: 2 | 4 | 6): Board {
  // Determine rules based on layer count
  const rulesMap: Record<2 | 4 | 6, 'jlcpcb-2l' | 'jlcpcb-4l' | 'jlcpcb-6l'> = {
    2: 'jlcpcb-2l',
    4: 'jlcpcb-4l',
    6: 'jlcpcb-6l',
  };

  const defaultNetClass: NetClass = {
    name: 'default',
    trackWidth: 0.25,
    clearance: 0.2,
    viaDrill: 0.3,
    viaDiameter: 0.6,
  };

  return {
    formatVersion: 1,
    name,
    copperLayers,
    outline: [],
    keepouts: [],
    holes: [],
    components: [],
    nets: [],
    netClasses: [defaultNetClass],
    tracks: [],
    vias: [],
    zones: [],
    silk: [],
    silkLines: [],
    dimensions: [],
    rules: rulesMap[copperLayers],
  };
}

/**
 * Serialize a Board to JSON string.
 * @param b - Board to serialize
 * @returns Pretty-printed JSON string
 */
export function serializeBoard(b: Board): string {
  return JSON.stringify(b, null, 2);
}

/**
 * Parse a Board from JSON string with validation.
 * Validates:
 * - Input is valid JSON and an object
 * - formatVersion exists and equals 1
 * - All required array properties exist
 *
 * @param json - JSON string to parse
 * @returns Parsed Board object
 * @throws Error if validation fails
 */
export function parseBoard(json: string): Board {
  let parsed: unknown;

  // Parse JSON
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Check it's an object
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Board must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Check formatVersion
  if (!('formatVersion' in obj)) {
    throw new Error('Missing required field: formatVersion');
  }
  if (obj.formatVersion !== 1) {
    throw new Error(
      `Unsupported formatVersion: ${obj.formatVersion}. Expected 1.`,
    );
  }

  // Check required arrays
  const requiredArrays = [
    'outline',
    'keepouts',
    'holes',
    'components',
    'nets',
    'netClasses',
    'tracks',
    'vias',
    'zones',
    'silk',
  ];
  for (const field of requiredArrays) {
    if (!(field in obj)) {
      throw new Error(`Missing required field: ${field}`);
    }
    if (!Array.isArray(obj[field])) {
      throw new Error(`Field "${field}" must be an array`);
    }
  }

  // `silkLines` and `dimensions` were added after the initial format; older
  // saved boards omit them. Default to [] rather than requiring them, so
  // those boards still load.
  if (!Array.isArray(obj.silkLines)) {
    obj.silkLines = [];
  }
  if (!Array.isArray(obj.dimensions)) {
    obj.dimensions = [];
  }

  return obj as unknown as Board;
}
