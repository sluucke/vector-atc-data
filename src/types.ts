/**
 * The shape of every file this repository publishes. Vector ATC keeps its own
 * copy of these types (src/lib/types.ts, src/lib/ops/airways.ts,
 * src/lib/ops/rpl.ts); a change here is a change to the release contract and
 * has to land there too.
 */

export type ProcedureCategory = "RNAV" | "CONV";
export type ProcedureType = "SID" | "STAR";

export interface Transition {
  fix: string;
  desc: string;
}

export interface Procedure {
  id: string;
  type: ProcedureType;
  runway: string;
  name: string;
  category: ProcedureCategory;
  /** Stable chart key from charts.json (AISWEB chart code, e.g. "SV02F"). */
  chartKey: string;
  /** Key into geometry.json procedures; null when no coding table is published. */
  geometryKey: string | null;
  fixes: string[];
  notes?: string;

  // SID-specific
  commonRoute?: string | null;
  transitions?: Transition[];

  // STAR-specific
  entryFixes?: string[];
  route?: string | null;
  iaf?: string | null;
}

export interface Chart {
  key: string;
  type: string;
  name: string;
  code: string;
  amdt: string;
  date: string;
  file: string;
}

export interface ChartCatalog {
  icao: string;
  syncedAt: string;
  source: string;
  charts: Chart[];
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** One coded leg of a procedure, as published in the DECEA coding table. */
export interface Leg {
  seq: number;
  fix: string | null;
  pathTerminator: string;
  altitude: string | null;
  distance: number | null;
  /** True course of the leg, when the table publishes one. */
  course?: number | null;
}

export interface ProcedureGeometry {
  title: string;
  chartKey: string;
  /** Transition name ("RWY" is the common segment) to its ordered legs. */
  transitions: Record<string, Leg[]>;
}

export interface AirportGeometry {
  icao: string;
  syncedAt: string;
  fixes: Record<string, GeoPoint>;
  runwayPoints: Record<string, { thr?: GeoPoint; der?: GeoPoint }>;
  /** True course of each runway, as published on the departure's first leg. */
  runwayCourses?: Record<string, number>;
  procedures: Record<string, ProcedureGeometry>;
}

export interface AiracInfo {
  cycle: string;
  effective: string;
  checkedAt: string;
  source: string;
}

export interface AirportFrequencies {
  dAtis: string[];
  twr: string[];
  app: string[];
  acc: string[];
  accExtended?: string[];
  /** Callsigns of the IVAO positions these frequencies belong to. */
  network?: { source: string; app: string | null; acc: string };
}

/** Static, slowly-changing operational data kept in our own dataset. */
export interface AirportOperationalData {
  /** Feet. The value controllers use on the network. */
  transitionAltitude: number;
  transitionAltitudeSource: string;
  /** Degrees, negative to the west, as printed on the aerodrome's charts. */
  magneticVariation?: number;
  magneticVariationSource?: string;
  /** Set when the published chart disagrees with the operational value. */
  chartTransitionAltitude?: number;
  chartTransitionAltitudeNote?: string;
  ivaoWikiUrl?: string;
}

export interface AirportMeta {
  icao: string;
  name: string;
  elevation: string;
  ta: string;
  msa: string;
  fir: string;
  operational?: AirportOperationalData;
  airac: AiracInfo;
  frequencies: AirportFrequencies;
  runways: string[];
  runwaysNote?: string;
  observations: string[];
}

/**
 * Where a chart page sits on the ground, from scripts/georef-charts.ts. The
 * affine maps a point of the page (pdf.js viewport at scale 1, origin top
 * left) to Web Mercator metres: X = a·u + b·v + c, Y = d·u + e·v + f.
 */
export interface ChartGeoref {
  file: string;
  pages: Record<
    number,
    {
      width: number;
      height: number;
      affine: [number, number, number, number, number, number];
      /** The fixes whose labels agreed with the fit. */
      fixes: string[];
      rmsMeters: number;
    }
  >;
}

export type LevelDirection = "forward" | "backward" | null;

export interface AirwaySegment {
  from: string;
  to: string;
  /** Magnetic track from `from` to `to`, as published. */
  track: number;
  reverseTrack: number;
  lengthNm: number | null;
  /** "FL245", "UNL", "5000FT"... as published. */
  lower: string | null;
  upper: string | null;
  odd: LevelDirection;
  even: LevelDirection;
  /**
   * One-way segment where the AIP table does not show which column its mark
   * is in; the parity was taken from the semicircular rule for that direction.
   */
  inferred?: boolean;
}

export interface AirwayDatabase {
  source: string;
  syncedAt: string;
  points: Record<string, GeoPoint>;
  routes: Record<string, AirwaySegment[]>;
}

export type Parity = "odd" | "even";

export interface RplRoute {
  level: number;
  route: string;
  count: number;
}

export interface RplPair {
  flights: number;
  /** Cruising level (hundreds of feet) to number of filed flights. */
  levels: Record<number, number>;
  /** Most filed routes, most common first. */
  routes: RplRoute[];
}

export interface RplDatabase {
  cycle: string;
  source: string;
  syncedAt: string;
  /** "SBBR-SBTE" -> summary */
  pairs: Record<string, RplPair>;
}

