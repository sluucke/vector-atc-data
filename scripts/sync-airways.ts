/**
 * Builds content/airways.json from the AIP Brasil.
 *
 *   npm run sync:airways              # downloads the current complete AIP
 *   npm run sync:airways -- aip.pdf   # or reads a PDF already on disk
 *
 * ENR 3.1 (conventional) and ENR 3.2 (RNAV) list every ATS route segment with
 * its magnetic track, vertical limits and, for each direction, whether odd or
 * even cruising levels apply. That allocation is what the semicircular check
 * needs: the AIP warns that some routes keep "level continuity" across bends,
 * so the track alone does not settle it. ENR 4.4 adds the coordinates of every
 * named point, airway or not, which direct legs need.
 */
import fs from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { download, fetchText, today } from "./lib/aisweb";
import type {
  AirwayDatabase,
  AirwaySegment,
  GeoPoint,
  LevelDirection,
} from "../src/types";

const AIP_INDEX = "https://aisweb.decea.mil.br/?i=publicacoes&p=aip";

interface Item {
  x: number;
  y: number;
  s: string;
}

/** "145422S" + "0461317W" -> decimal degrees */
function coordinate(lat: string, lon: string): GeoPoint {
  const dms = (v: string, degDigits: number) => {
    const sign = /[SW]$/.test(v) ? -1 : 1;
    const d = Number(v.slice(0, degDigits));
    const m = Number(v.slice(degDigits, degDigits + 2));
    const s = Number(v.slice(degDigits + 2, -1));
    return sign * (d + m / 60 + s / 3600);
  };
  return { lat: dms(lat, 2), lon: dms(lon, 3) };
}

const COORD = /^(\d{6}(?:\.\d+)?[NS])\s+(\d{7}(?:\.\d+)?[EW])$/;
const ROUTE = /^[A-Z]{1,2}\d{1,4}$/;

/** Lines of one page, top to bottom, fragments ordered by x. */
async function pageLines(
  doc: Awaited<ReturnType<typeof getDocument>["promise"]>,
  p: number
): Promise<Item[][]> {
  const content = await (await doc.getPage(p)).getTextContent();
  const byY = new Map<number, Item[]>();
  for (const it of content.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    const key = [...byY.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    const line = byY.get(key) ?? [];
    line.push({ x: it.transform[4], y, s: it.str.trim() });
    byY.set(key, line);
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, items]) => items.sort((a, b) => a.x - b.x));
}

interface PendingPoint {
  name: string;
  point: GeoPoint | null;
}

interface PendingSegment {
  tracks: number[];
  limits: string[];
  length: number | null;
  odd: LevelDirection;
  even: LevelDirection;
  /** The first allocation seen wins; later marks belong to another segment. */
  marked: boolean;
  /** One-way segment whose column the PDF does not reveal. */
  lone: LevelDirection;
}

const emptySegment = (): PendingSegment => ({
  tracks: [],
  limits: [],
  length: null,
  odd: null,
  even: null,
  marked: false,
  lone: null,
});

/** "↓" is the order the table lists the points in; "↑" the reverse; "x" none. */
const arrow = (s: string): LevelDirection =>
  s === "↓" ? "forward" : s === "↑" ? "backward" : null;

function parseRoutes(pages: { lines: Item[][]; route: string }[]) {
  const routes: Record<string, AirwaySegment[]> = {};
  const points: Record<string, GeoPoint> = {};

  let route: string | null = null;
  let previous: PendingPoint | null = null;
  let segment = emptySegment();

  const closeSegment = (next: PendingPoint) => {
    if (route && previous?.point && next.point && segment.tracks.length > 0) {
      const [lower, upper] = orderLimits(segment.limits);
      const track = segment.tracks[0];
      const reverseTrack = segment.tracks[1] ?? (track + 180) % 360;
      let { odd, even } = segment;
      if (segment.lone) {
        const flown = segment.lone === "forward" ? track : reverseTrack;
        if (flown < 180) odd = segment.lone;
        else even = segment.lone;
      }
      (routes[route] ??= []).push({
        from: previous.name,
        to: next.name,
        track,
        reverseTrack,
        lengthNm: segment.length,
        lower,
        upper,
        odd,
        even,
        ...(segment.lone ? { inferred: true } : {}),
      });
    }
    segment = emptySegment();
  };

  for (const page of pages) {
    if (page.route !== route) {
      // A new route starts on this page; nothing carries over.
      route = page.route;
      previous = null;
      segment = emptySegment();
    }

    let pendingName: string | null = null;

    for (const line of page.lines) {
      const text = line.map((i) => i.s).join(" ");

      // A point's name sits on the line above its coordinates, after a symbol.
      const coord = text.match(COORD);
      if (coord) {
        if (pendingName) {
          const point = coordinate(coord[1], coord[2]);
          const current = { name: pendingName, point };
          points[pendingName] ??= point;
          if (previous) closeSegment(current);
          previous = current;
          pendingName = null;
        }
        continue;
      }

      // Names can carry spaces ("CAMPO GRANDE"); a navaid line may follow.
      const named = text.match(/^[∆▲△■◆●○]\s*([A-Z][A-Z ]{1,30})$/);
      if (named) {
        pendingName = named[1].trim();
        continue;
      }

      // Navaids are filed by their identifier ("LET"), not their name
      // ("LETICIA"), which the AIP prints on the next line.
      const navaid = text.match(/^(?:D?VOR\/DME|VORTAC|D?VOR|NDB\/DME|NDB|DME)\s+([A-Z]{2,3})$/);
      if (navaid && pendingName) {
        pendingName = navaid[1];
        continue;
      }

      if (!previous) continue;

      for (const it of line) {
        if (/^\d{3}°$/.test(it.s)) segment.tracks.push(Number(it.s.slice(0, 3)));
        else if (/^[\d.]+\s*NM$/.test(it.s)) segment.length = parseFloat(it.s);
        else if (/^(UNL|GND|FL\s?\d{2,3}|\d{3,5}\s*FT)$/.test(it.s))
          segment.limits.push(it.s.replace(/\s+/g, ""));
        else if (/^[↓↑x](\s+[↓↑x])?$/.test(it.s) && !segment.marked) {
          segment.marked = true;
          const marks = it.s.split(/\s+/);
          if (marks.length === 2) {
            segment.odd = arrow(marks[0]);
            segment.even = arrow(marks[1]);
          } else {
            // A lone mark only says which way the route may be flown: its
            // position does not tell the columns apart (the same x carries an
            // odd mark on UZ171 and an even one on UZ45). The parity is then
            // the semicircular one for that direction, and is flagged so.
            segment.lone = arrow(marks[0]);
          }
        }
      }
    }
  }

  return { routes, points };
}

/** Limits arrive as upper, lower and sometimes an MEA; keep lower and upper. */
function orderLimits(limits: string[]): [string | null, string | null] {
  const value = (s: string) =>
    s === "UNL" ? 9999 : s === "GND" ? 0 : s.startsWith("FL") ? Number(s.slice(2)) : Number(s.replace("FT", "")) / 100;
  const sorted = [...new Set(limits.slice(0, 2))].sort((a, b) => value(a) - value(b));
  return [sorted[0] ?? null, sorted[sorted.length - 1] ?? null];
}

/** ENR 4.4: "ESBOD 171753S 0490503W UZ31, Z82" */
function parseSignificantPoints(text: string, points: Record<string, GeoPoint>) {
  for (const m of text.matchAll(/\b([A-Z]{5})\s+(\d{6}(?:\.\d+)?[NS])\s+(\d{7}(?:\.\d+)?[EW])/g)) {
    points[m[1]] ??= coordinate(m[2], m[3]);
  }
}

/**
 * ENR 4.1 lists every VOR, DME and NDB. A row carries the identifier and the
 * latitude on one line and the longitude on the next:
 *   "Luziania   LUZ  113.100 MHZ  H24  161539S ..."
 *   "VOR/DME         CH 78X            0475816W ..."
 * Conventional procedures are flown on these navaids, and the coding tables
 * name them without giving their position.
 */
function parseNavaids(lines: Item[][], navaids: Record<string, GeoPoint>) {
  for (let i = 0; i < lines.length - 1; i++) {
    const ident = lines[i].find((it) => /^[A-Z]{2,3}$/.test(it.s) && it.x > 140 && it.x < 180);
    const lat = lines[i].find((it) => /^\d{6}(?:\.\d+)?[NS]$/.test(it.s));
    const lon = lines[i + 1].find((it) => /^\d{7}(?:\.\d+)?[EW]$/.test(it.s));
    if (ident && lat && lon) navaids[ident.s] ??= coordinate(lat.s, lon.s);
  }
}

async function loadAip(): Promise<Buffer> {
  const local = process.argv[2];
  if (local) return fs.readFileSync(local);
  const html = await fetchText(AIP_INDEX);
  const href = html.match(/download\/\?public=[^"&]+\.pdf&p=Completa/)?.[0];
  if (!href) throw new Error("Link da AIP completa não encontrado em " + AIP_INDEX);
  console.log("Baixando a AIP completa (~55 MB)…");
  return download(`https://aisweb.decea.mil.br/${href}`);
}

const buffer = await loadAip();
const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;

const routePages: { lines: Item[][]; route: string }[] = [];
const points: Record<string, GeoPoint> = {};
const navaids: Record<string, GeoPoint> = {};

for (let p = 1; p <= doc.numPages; p++) {
  const lines = await pageLines(doc, p);
  const head = lines
    .slice(0, 3)
    .map((l) => l.map((i) => i.s).join(" "))
    .join(" ");

  const route = head.match(/ENR 3\.[12] ([A-Z]{1,2}\d{1,4}) - \d+/)?.[1];
  if (route && ROUTE.test(route)) {
    routePages.push({ lines, route });
    continue;
  }
  if (/ENR 4\.1 - \d+/.test(head)) {
    parseNavaids(lines, navaids);
  }
  if (/ENR 4\.4 - \d+/.test(head)) {
    parseSignificantPoints(lines.map((l) => l.map((i) => i.s).join(" ")).join(" "), points);
  }
}

const parsed = parseRoutes(routePages);
for (const [name, point] of Object.entries(parsed.points)) points[name] ??= point;
for (const [ident, point] of Object.entries(navaids)) points[ident] ??= point;

const segments = Object.values(parsed.routes).flat();
const db: AirwayDatabase = {
  source: AIP_INDEX,
  syncedAt: today(),
  points: Object.fromEntries(
    Object.entries(points)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { lat: Number(v.lat.toFixed(5)), lon: Number(v.lon.toFixed(5)) }])
  ),
  routes: Object.fromEntries(Object.entries(parsed.routes).sort(([a], [b]) => a.localeCompare(b))),
};

const out = path.join("content", "airways.json");
fs.writeFileSync(out, JSON.stringify(db) + "\n");

const withAllocation = segments.filter((s) => s.odd || s.even).length;
console.log(
  `${Object.keys(db.routes).length} aerovias, ${segments.length} trechos ` +
    `(${withAllocation} com sentido de nível), ${Object.keys(db.points).length} pontos ` +
    `(${Object.keys(navaids).length} auxílios-rádio).`
);
console.log(`Gravado em ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB).`);
