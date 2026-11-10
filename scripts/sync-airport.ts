/**
 * Syncs one aerodrome from the AISWEB (DECEA) public API.
 *
 *   npm run sync:airport -- SBSV
 *
 * Downloads every published chart into charts/<ICAO>/ and parses the
 * coding tables into content/<ICAO>/{charts,geometry}.json. Coding tables are
 * the authoritative source for waypoint coordinates and leg sequences — the
 * graphic charts only draw them.
 *
 * Charts already on disk are not downloaded again; set REFRESH_CHARTS=1 to
 * force it.
 */
import fs from "node:fs";
import path from "node:path";
import {
  TMA_CHART_TYPES,
  download,
  fetchAisweb,
  icaoArg,
  slug,
  tag,
  today,
} from "./lib/aisweb";
import { pdfRows } from "./lib/pdf";
import { AISWEB_API } from "../src/aisweb-credentials";
import type {
  AirportGeometry,
  Chart,
  ChartCatalog,
  GeoPoint,
  Leg,
  ProcedureGeometry,
} from "../src/types";

// Obstacle charts (AOC) aren't used for procedure work and would double the
// repository size for every aerodrome.
const SKIP_TYPES = new Set(["AOC"]);

type RunwayPoints = AirportGeometry["runwayPoints"];

interface ParsedProcedure {
  type: string;
  title: string;
  name: string;
  runway: string;
  transitions: Record<string, Leg[]>;
}

interface ParsedTable {
  procedures: ParsedProcedure[];
  fixes: Record<string, GeoPoint>;
  runwayPoints: RunwayPoints;
  runwayCourses: Record<string, number>;
}

/** "S 13:08:30.75" / "W 38:12:28.40" -> signed decimal degrees */
function toDecimal(hemisphere: string, dms: string): number {
  const [d, m, s] = dms.split(":").map(Number);
  const value = d + m / 60 + s / 3600;
  return hemisphere === "S" || hemisphere === "W" ? -value : value;
}

/**
 * A coding table holds one or more procedures. Each starts with a header row
 * ("SID RNAV UMPEL 1A RWY 10"), followed by leg rows keyed by transition.
 */
function parseCodingTable(rows: string[][]): ParsedTable {
  const procedures: ParsedProcedure[] = [];
  const fixes: Record<string, GeoPoint> = {};
  const runwayPoints: RunwayPoints = {};
  const runwayCourses: Record<string, number> = {};
  let current: ParsedProcedure | null = null;

  for (const row of rows) {
    const [first = "", ...rest] = row;
    const joined = row.join(" ");

    // The title is one line on the page but reaches us split across anywhere
    // from one cell to five, sometimes trailed by the aerodrome name and the
    // sheet's own index, and "RWY 32" is as common as "RWY32". So match the
    // whole row with the spacing normalised, and stop at the runway.
    const header = joined
      .replace(/\s+/g, " ")
      .trim()
      .match(
        /^(SID|STAR|IAC)\s+(.+?)\s+RWY\s*([0-9]{2}[LRC]?(?:\s*\/\s*[0-9]{2}[LRC]?)?)(?![0-9A-Z])/
      );
    if (header) {
      current = {
        type: header[1],
        title: `${header[1]} ${header[2]} RWY ${header[3]}`,
        name: header[2].replace(/^RNAV\s+/, "").trim(),
        runway: header[3].replace(/\s*\/\s*/g, "/"),
        transitions: {},
      };
      procedures.push(current);
      continue;
    }

    // Coordinate rows: "GEDEX", "S 13:08:30.75W 38:12:28.40". Navaids carry
    // their type first ("VOR/DME FSA"); conventional procedures are flown on
    // them, so without this their legs have nowhere to start or end.
    const coord = joined.match(
      /^(?:(?:D?VOR(?:\/DME)?|VORTAC|NDB(?:\/DME)?|DME|TACAN)\s+)?([A-Z0-9]{2,6})\s+([NS])\s*(\d{1,3}:\d{2}:\d{2}(?:\.\d+)?)\s*([EW])\s*(\d{1,3}:\d{2}:\d{2}(?:\.\d+)?)/
    );
    if (coord) {
      const ident = coord[1];
      const point = {
        lat: toDecimal(coord[2], coord[3]),
        lon: toDecimal(coord[4], coord[5]),
      };
      // IAC tables publish thresholds as "RWY10"; SID tables publish the
      // departure end of the same runway as a bare "10".
      const threshold = ident.match(/^RWY(\d{2}[LRC]?)$/);
      const der = ident.match(/^(\d{2}[LRC]?)$/);
      if (threshold) (runwayPoints[threshold[1]] ??= {}).thr = point;
      else if (der) (runwayPoints[der[1]] ??= {}).der = point;
      else fixes[ident] = point;
      continue;
    }

    // Leg rows: seq | transition | flyOver | navaid | fix | pathTerminator | ...
    if (!current || !/^\d+$/.test(first) || rest.length < 5) continue;
    const [transition, , , fixIdent, pathTerminator] = rest;
    if (!/^[A-Z0-9]{2,6}$/.test(transition) && transition !== "RWY") continue;

    const altitude = rest.find((v) => /^[+\-@]\d{3,5}$/.test(v)) ?? null;
    const distance = rest.find((v) => /^\d{1,3}\.\d{2}$/.test(v)) ?? null;
    // Courses come as two cells, "161.79° True" and "183.22° Mag", in either
    // order. True is the one comparable with geographic bearings.
    const trueCourse =
      rest
        .find((v) => /^\d{1,3}(\.\d+)?\s*°?\s*True$/i.test(v))
        ?.match(/[\d.]+/)?.[0] ?? null;

    // A departure's first leg flies the runway centreline, so its course is the
    // runway's own. That is the only bearing available at an aerodrome whose
    // coding tables publish a single point for the strip.
    if (
      trueCourse &&
      transition === "RWY" &&
      Number(first) === 10 &&
      /^(CA|CF|VA|FA)$/.test(pathTerminator) &&
      current.type === "SID" &&
      /^\d{2}[LRC]?$/.test(current.runway)
    ) {
      runwayCourses[current.runway] ??= Number(trueCourse);
    }

    (current.transitions[transition] ??= []).push({
      seq: Number(first),
      // "BH007*" marks a fly-over fix; the asterisk is not part of the name.
      fix: fixIdent === "N/A" ? null : fixIdent.replace(/\*/g, ""),
      pathTerminator,
      altitude,
      distance: distance ? Number(distance) : null,
      course: trueCourse ? Number(trueCourse) : null,
    });
  }

  for (const proc of procedures) {
    for (const legs of Object.values(proc.transitions)) {
      legs.sort((a, b) => a.seq - b.seq);
    }
  }

  return { procedures, fixes, runwayPoints, runwayCourses };
}

const icao = icaoArg("sync:airport");
const chartsDir = path.join("charts", icao);
const contentDir = path.join("content", icao);

const items = (await fetchAisweb("cartas", icao)).split("<item ").slice(1);
if (items.length === 0) {
  console.error(`No charts returned for ${icao}.`);
  process.exit(1);
}

fs.mkdirSync(chartsDir, { recursive: true });
fs.mkdirSync(contentDir, { recursive: true });

// TMA charts (ARC, ATCSMAC, REA) come from scripts/sync-tma.ts, so keep them.
const catalogPath = path.join(contentDir, "charts.json");
const tmaCharts: Chart[] = fs.existsSync(catalogPath)
  ? (JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as ChartCatalog).charts.filter(
      (c) => TMA_CHART_TYPES.has(c.type)
    )
  : [];

const charts: Chart[] = [...tmaCharts];
const allFixes: Record<string, GeoPoint> = {};
const allRunwayPoints: RunwayPoints = {};
const allRunwayCourses: Record<string, number> = {};
const geometry: Record<string, ProcedureGeometry> = {};

for (const item of items) {
  const type = tag(item, "tipo");
  if (SKIP_TYPES.has(type)) continue;

  const name = tag(item, "nome");
  const code = tag(item, "icp");
  const key = code || slug(name);
  const file = `${slug(type)}-${slug(key)}-${slug(name)}.pdf`;

  const pdfPath = path.join(chartsDir, file);
  if (!fs.existsSync(pdfPath) || process.env.REFRESH_CHARTS) {
    const pdfUrl = tag(item, "link").replace(/&amp;/g, "&");
    fs.writeFileSync(pdfPath, await download(pdfUrl));
  }

  charts.push({
    key,
    type,
    name,
    code,
    amdt: tag(item, "amdt"),
    date: tag(item, "dt"),
    file: `/charts/${icao}/${file}`,
  });

  const tabUrl = tag(item, "tabcode").replace(/&amp;/g, "&");
  if (!tabUrl) {
    console.log(`  ${type.padEnd(4)} ${name}  (sem coding table)`);
    continue;
  }

  const parsed = parseCodingTable(await pdfRows(await download(tabUrl)));
  Object.assign(allFixes, parsed.fixes);
  Object.assign(allRunwayPoints, parsed.runwayPoints);
  Object.assign(allRunwayCourses, parsed.runwayCourses);

  for (const proc of parsed.procedures) {
    const geoKey = `${proc.type}|${proc.name.replace(/\s+/g, "")}|${proc.runway}`;
    geometry[geoKey] = {
      title: proc.title,
      chartKey: key,
      transitions: proc.transitions,
    };
  }

  console.log(
    `  ${type.padEnd(4)} ${name}  → ${parsed.procedures.length} proc, ` +
      `${Object.keys(parsed.fixes).length} fixos`
  );
}

const catalog: ChartCatalog = {
  icao,
  syncedAt: today(),
  source: `${AISWEB_API}?area=cartas&icaoCode=${icao}`,
  charts: charts.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
  ),
};
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

const airportGeometry: AirportGeometry = {
  icao,
  syncedAt: today(),
  fixes: Object.fromEntries(
    Object.entries(allFixes).sort(([a], [b]) => a.localeCompare(b))
  ),
  runwayPoints: allRunwayPoints,
  runwayCourses: allRunwayCourses,
  procedures: geometry,
};
fs.writeFileSync(
  path.join(contentDir, "geometry.json"),
  JSON.stringify(airportGeometry, null, 2) + "\n"
);

console.log(
  `\n${icao}: ${charts.length} cartas, ${Object.keys(allFixes).length} fixos, ` +
    `${Object.keys(geometry).length} procedimentos com geometria.`
);
