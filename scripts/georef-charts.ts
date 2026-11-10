/**
 * Georeferences chart pages so the map can draw them under the procedure.
 *
 *   npm run georef:charts            # every aerodrome
 *   npm run georef:charts -- SBBR    # one aerodrome
 *
 * A chart prints the identifier of every fix next to its symbol, and the
 * coding tables and the AIP give those fixes' coordinates. Each identifier on
 * the page is a control point. A robust north-up fit (RANSAC over pairs, then
 * least squares on the inliers) maps page coordinates to Web Mercator, and a
 * second pass moves each control point from its label to the fix symbol.
 *
 * Only pages that are drawn to scale survive: a page is kept when half of the
 * fixes it names agree and the residual is small. Schematic charts ("not to
 * scale" SIDs and STARs) fail those tests, so nothing is guessed. So does the
 * area chart (ARC) for now: one fit leaves several NM across a whole TMA.
 * The result is an underlay to read the chart against the map, not a
 * navigation source.
 */
import fs from "node:fs";
import path from "node:path";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  AirportGeometry,
  AirwayDatabase,
  ChartCatalog,
  ChartGeoref,
  GeoPoint,
} from "../src/types";

const TYPES = new Set(["SID", "STAR", "IAC", "ARC", "ATCSMAC", "VAC", "REA"]);
const R = 6378137;
/** National points farther than this from the aerodrome are not candidates. */
const RADIUS_NM = 250;
/** Labels sit a few millimetres off their symbols: about 1 km on an IAC. */
const MAX_RMS_METERS = 1000;
const MAX_RMS_RATIO = 0.02;

const mercator = (p: GeoPoint): [number, number] => [
  (R * p.lon * Math.PI) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)),
];

const distanceNm = (a: GeoPoint, b: GeoPoint) => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
};

interface Match {
  u: number;
  v: number;
  X: number;
  Y: number;
  ident: string;
}

/** [a, b, c, d, e, f]: X = a·u + b·v + c, Y = d·u + e·v + f */
type Affine = [number, number, number, number, number, number];

function solve(m: number[][], r: number[]): number[] | null {
  // Gauss-Jordan elimination with partial pivoting.
  const n = r.length;
  const a = m.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(a[i][c]) > Math.abs(a[p][c])) p = i;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const k = a[i][c] / a[c][c];
      for (let j = c; j <= n; j++) a[i][j] -= k * a[c][j];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/**
 * Least-squares fit of a north-up page to Mercator: one scale and an offset,
 * with the sheet turned by a whole number of quarter turns (some charts are
 * drawn sideways). Aeronautical charts are conformal and north-up, so this is
 * all the freedom a real map needs; a schematic layout cannot hide in a
 * rotation or a shear, and an approach whose fixes lie on one line still fits.
 * The page's v grows downwards while Y grows north:
 *   (u', v') = page point turned by θ,  X = s·u' + c,  Y = −s·v' + f
 */
function fit(points: Match[], quarter: number): Affine | null {
  const cos = Math.round(Math.cos((quarter * Math.PI) / 2));
  const sin = Math.round(Math.sin((quarter * Math.PI) / 2));
  const ata = Array.from({ length: 3 }, () => [0, 0, 0]);
  const atb = [0, 0, 0];
  for (const p of points) {
    const u = cos * p.u - sin * p.v;
    const v = sin * p.u + cos * p.v;
    for (const [row, target] of [
      [[u, 1, 0], p.X],
      [[-v, 0, 1], p.Y],
    ] as [number[], number][]) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) ata[i][j] += row[i] * row[j];
        atb[i] += row[i] * target;
      }
    }
  }
  const x = solve(ata, atb);
  if (!x || x[0] <= 0) return null;
  const [scale, c, f] = x;
  return [scale * cos, -scale * sin, c, -scale * sin, -scale * cos, f];
}

const apply = (t: Affine, u: number, v: number): [number, number] => [
  t[0] * u + t[1] * v + t[2],
  t[3] * u + t[4] * v + t[5],
];

const error = (t: Affine, m: Match) => {
  const [X, Y] = apply(t, m.u, m.v);
  return Math.hypot(X - m.X, Y - m.Y);
};

function robustFit(
  matches: Match[]
): { t: Affine; inliers: Match[]; rms: number; span: number; quarter: number } | null {
  if (matches.length < 4) return null;
  let best: { t: Affine; inliers: Match[]; quarter: number } | null = null;

  // The spread of the candidate fixes on the ground sets the tolerance.
  const xs = matches.map((m) => m.X);
  const ys = matches.map((m) => m.Y);
  const spread = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const tolerance = Math.max(300, spread * 0.03);

  for (let quarter = 0; quarter < 4; quarter++)
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      if (matches[i].ident === matches[j].ident) continue;
      const t = fit([matches[i], matches[j]], quarter);
      if (!t) continue;
      const inliers = matches.filter((m) => error(t, m) < tolerance);
      // One label per fix: keep the occurrence that agrees best.
      const byIdent = new Map<string, Match>();
      for (const m of inliers) {
        const prev = byIdent.get(m.ident);
        if (!prev || error(t, m) < error(t, prev)) byIdent.set(m.ident, m);
      }
      const unique = [...byIdent.values()];
      if (!best || unique.length > best.inliers.length) best = { t, inliers: unique, quarter };
    }
  }
  if (!best || best.inliers.length < 4) return null;

  const t = fit(best.inliers, best.quarter);
  if (!t) return null;
  const residuals = best.inliers.map((m) => error(t, m));
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
  const ix = best.inliers.map((m) => m.X);
  const iy = best.inliers.map((m) => m.Y);
  const span = Math.hypot(Math.max(...ix) - Math.min(...ix), Math.max(...iy) - Math.min(...iy));
  return { t, inliers: best.inliers, rms, span, quarter: best.quarter };
}

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>["promise"]>["getPage"]>>;
type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  n[0] * m[0] + n[1] * m[2],
  n[0] * m[1] + n[1] * m[3],
  n[2] * m[0] + n[3] * m[2],
  n[2] * m[1] + n[3] * m[3],
  n[4] * m[0] + n[5] * m[2] + m[4],
  n[4] * m[1] + n[5] * m[3] + m[5],
];

/**
 * Centres of the small, roughly square drawings on a page, in viewport
 * coordinates: fix and navaid symbols among them. A label sits beside its
 * symbol, so fitting on labels shifts the whole chart by that offset; once a
 * first fit says where each fix should be, the nearest symbol pins it.
 */
async function symbolCentres(page: PdfPage, viewport: ReturnType<PdfPage["getViewport"]>) {
  const list = await page.getOperatorList();
  const centres: [number, number][] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args[0])) ctm = multiply(ctm, args[0] as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const box = args[2] as Record<number, number> | null;
      if (!box) continue;
      const corners = [
        [box[0], box[1]],
        [box[2], box[1]],
        [box[0], box[3]],
        [box[2], box[3]],
      ].map(([x, y]) =>
        viewport.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5])
      );
      const us = corners.map((c) => c[0]);
      const vs = corners.map((c) => c[1]);
      const w = Math.max(...us) - Math.min(...us);
      const h = Math.max(...vs) - Math.min(...vs);
      if (w < 3 || h < 3 || w > 16 || h > 16 || Math.max(w, h) / Math.min(w, h) > 1.8) continue;
      centres.push([(Math.max(...us) + Math.min(...us)) / 2, (Math.max(...vs) + Math.min(...vs)) / 2]);
    }
  }
  return centres;
}

/** Where a ground point falls on the page under the fit. */
function toPage(t: Affine, X: number, Y: number): [number, number] {
  const [a, b, c, d, e, f] = t;
  const det = a * e - b * d;
  return [(e * (X - c) - b * (Y - f)) / det, (a * (Y - f) - d * (X - c)) / det];
}

/** Moves each control point from its label to the symbol nearest the fit. */
function snapToSymbols(t: Affine, inliers: Match[], centres: [number, number][]): Match[] {
  return inliers.map((m) => {
    const [pu, pv] = toPage(t, m.X, m.Y);
    let best: [number, number] | null = null;
    let bestDistance = 20;
    for (const c of centres) {
      const dist = Math.hypot(c[0] - pu, c[1] - pv);
      if (dist < bestDistance) {
        bestDistance = dist;
        best = c;
      }
    }
    return best ? { ...m, u: best[0], v: best[1] } : m;
  });
}

const airways = JSON.parse(fs.readFileSync(path.join("content", "airways.json"), "utf-8")) as AirwayDatabase;
const only = process.argv[2]?.toUpperCase();
const airports = fs
  .readdirSync("content")
  .filter((d) => /^S[A-Z]{3}$/.test(d) && (!only || d === only));

for (const icao of airports) {
  const dir = path.join("content", icao);
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, "charts.json"), "utf-8")) as ChartCatalog;
  const geometry = JSON.parse(fs.readFileSync(path.join(dir, "geometry.json"), "utf-8")) as AirportGeometry;

  const runwayEnds = Object.values(geometry.runwayPoints).flatMap((r) => [r.thr, r.der]).filter(Boolean) as GeoPoint[];
  const home = runwayEnds[0] ?? Object.values(geometry.fixes)[0];
  if (!home) continue;

  const known: Record<string, GeoPoint> = {};
  for (const [ident, p] of Object.entries(airways.points)) {
    if (/^[A-Z0-9]{3,5}$/.test(ident) && distanceNm(home, p) < RADIUS_NM) known[ident] = p;
  }
  Object.assign(known, geometry.fixes);

  const out: Record<string, ChartGeoref> = {};
  let tried = 0;

  for (const chart of catalog.charts.filter((c) => TYPES.has(c.type))) {
    const file = path.join(".", chart.file);
    if (!fs.existsSync(file)) continue;
    tried++;
    const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
    const pages: ChartGeoref["pages"] = {};

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const matches: Match[] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const ident = it.str.trim().replace(/\*$/, "");
        const at = known[ident];
        if (!at) continue;
        const [u, v] = viewport.convertToViewportPoint(
          it.transform[4] + it.width / 2,
          it.transform[5] + it.height / 2
        );
        const [X, Y] = mercator(at);
        matches.push({ u, v, X, Y, ident });
      }

      const coarse = robustFit(matches);
      if (!coarse) continue;
      let result = coarse;
      const snapped = snapToSymbols(coarse.t, coarse.inliers, await symbolCentres(page, viewport));
      const refined = fit(snapped, coarse.quarter);
      if (refined) {
        const rms = Math.sqrt(snapped.reduce((sum, m) => sum + error(refined, m) ** 2, 0) / snapped.length);
        if (rms < coarse.rms) result = { ...coarse, t: refined, inliers: snapped, rms };
      }
      // A schematic chart places a few fixes plausibly and the rest wherever
      // they fit on the sheet, so half of the fixes it names must agree, and
      // the residual must stay small both absolutely and against the spread.
      // "NOT TO SCALE" is no help: IACs print it for the profile view only.
      const named = new Set(matches.map((m) => m.ident)).size;
      // A fix agrees when it pinned the fit, or when its label lies within
      // 3 km of where the fit puts it (labels sit a few millimetres away).
      const final = result;
      const agreeing = new Set([
        ...final.inliers.map((m) => m.ident),
        ...matches.filter((m) => error(final.t, m) < 3000).map((m) => m.ident),
      ]).size;
      const ratio = result.rms / result.span;
      if (process.env.GEOREF_DEBUG) {
        console.log(
          `  ${chart.type.padEnd(7)} ${chart.key.padEnd(14)} p${p} ` +
            `${result.inliers.length}/${agreeing}/${named} rms=${Math.round(coarse.rms)}m -> ${Math.round(result.rms)}m ${(ratio * 100).toFixed(2)}% q=${result.quarter}`
        );
      }
      if (
        agreeing / named < 0.5 ||
        result.rms > MAX_RMS_METERS ||
        ratio > MAX_RMS_RATIO
      ) {
        continue;
      }
      pages[p] = {
        width: Number(viewport.width.toFixed(2)),
        height: Number(viewport.height.toFixed(2)),
        affine: result.t.map((n) => Number(n.toPrecision(10))) as ChartGeoref["pages"][number]["affine"],
        fixes: result.inliers.map((m) => m.ident).sort(),
        rmsMeters: Math.round(result.rms),
      };
    }
    if (Object.keys(pages).length > 0) out[chart.key] = { file: chart.file, pages };
    await doc.cleanup();
  }

  fs.writeFileSync(path.join(dir, "georef.json"), JSON.stringify(out, null, 2) + "\n");
  const summary = Object.entries(out)
    .map(([k, g]) => `${k}(${Object.keys(g.pages).join(",")})`)
    .join(" ");
  console.log(`${icao}: ${Object.keys(out).length}/${tried} cartas em escala  ${summary}`);
}
