/**
 * Builds content/rpl.json from the CGNA repetitive flight plans (RPL).
 *
 *   npm run sync:rpl
 *
 * The RPL file is what Brazilian airlines file for their scheduled flights:
 * route and cruising level for every city pair they fly. It is the practical
 * answer to "which level does this route use", and the cruising-level check
 * cites it next to the AIP rule. The same source powers mach.jpedroh.dev.
 *
 * CGNA's server presents a certificate chained to ICP-Brasil, a root Node does
 * not ship, so this one public download skips certificate verification. The
 * file is then checked for the expected fixed-width layout before use.
 */
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { today } from "./lib/aisweb";
import type { RplDatabase, RplPair } from "../src/types";

const BASE = "https://portal.cgna.decea.mil.br/files/abas";

function get(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false, headers: { "User-Agent": "vector-atc/1.0" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

/** CGNA publishes a new file every few weeks under the date it takes effect. */
async function latestCycle(): Promise<string> {
  const day = new Date();
  for (let i = 0; i < 120; i++) {
    const date = day.toISOString().slice(0, 10);
    const res = await get(`${BASE}/${date}/painel_rpl/bdr/RPL_NAVBRASIL.zip`);
    if (res.status === 200 && res.body.length > 1000) return date;
    day.setUTCDate(day.getUTCDate() - 1);
  }
  throw new Error("Nenhum ciclo RPL encontrado nos últimos 120 dias");
}

/** The RPL zip holds one text file; read it from the central directory. */
function unzipFirst(zip: Buffer): string {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOffset = zip.readUInt32LE(eocd + 16);
  const method = zip.readUInt16LE(cdOffset + 10);
  const compressed = zip.readUInt32LE(cdOffset + 20);
  const local = zip.readUInt32LE(cdOffset + 42);
  const nameLen = zip.readUInt16LE(local + 26);
  const extraLen = zip.readUInt16LE(local + 28);
  const data = zip.subarray(local + 30 + nameLen + extraLen, local + 30 + nameLen + extraLen + compressed);
  const raw = method === 8 ? zlib.inflateRawSync(data) : data;
  return raw.toString("latin1");
}

interface Flight {
  callsign: string;
  departure: string;
  arrival: string;
  level: number;
  route: string;
}

/**
 * Fixed-width lines, e.g.
 * "111126 111126 0030000 GLO1752 B38M/M SBBR0015 N0444 390 PULUV UZ5 GUEST DCT    SBTE0151 EQPT/..."
 */
function parseLine(line: string): Flight | null {
  const m = line
    .trim()
    .match(/^\d{6} (?:\d{6}|UFN) +\d{7} (\S+) +\S+ ([A-Z]{4})\d{4} [NKM]\d{4} (\d{3}) (.+?) {2,}([A-Z]{4})\d{4}/);
  if (!m) return null;
  return {
    callsign: m[1],
    departure: m[2],
    level: Number(m[3]),
    route: m[4].trim().replace(/\s+/g, " "),
    arrival: m[5],
  };
}

const cycle = await latestCycle();
console.log(`Ciclo RPL: ${cycle}`);
const zip = await get(`${BASE}/${cycle}/painel_rpl/bdr/RPL_NAVBRASIL.zip`);
const lines = unzipFirst(zip.body).split(/\r?\n/);

const flights = lines.map(parseLine).filter((f): f is Flight => f !== null);
if (flights.length < 1000) {
  throw new Error(`Só ${flights.length} planos lidos de ${lines.length} linhas — o formato mudou?`);
}

const pairs: Record<string, RplPair> = {};
const routeCounts = new Map<string, Map<string, number>>();

for (const f of flights) {
  const key = `${f.departure}-${f.arrival}`;
  const pair = (pairs[key] ??= { flights: 0, levels: {}, routes: [] });
  pair.flights++;
  pair.levels[f.level] = (pair.levels[f.level] ?? 0) + 1;
  const byRoute = routeCounts.get(key) ?? new Map<string, number>();
  const rk = `${f.level}|${f.route}`;
  byRoute.set(rk, (byRoute.get(rk) ?? 0) + 1);
  routeCounts.set(key, byRoute);
}

for (const [key, byRoute] of routeCounts) {
  pairs[key].routes = [...byRoute.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([rk, count]) => {
      const [level, route] = rk.split("|");
      return { level: Number(level), route, count };
    });
}

const db: RplDatabase = {
  cycle,
  source: `${BASE}/${cycle}/painel_rpl/bdr/RPL_NAVBRASIL.zip`,
  syncedAt: today(),
  pairs: Object.fromEntries(Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b))),
};

const out = path.join("content", "rpl.json");
fs.writeFileSync(out, JSON.stringify(db) + "\n");
console.log(
  `${flights.length} planos de ${lines.length} linhas, ${Object.keys(pairs).length} pares. ` +
    `Gravado em ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB).`
);
