/**
 * Derives content/<ICAO>/procedures.json (and a meta.json skeleton) from what
 * sync-airport.ts already downloaded.
 *
 *   npm run build:content -- SBBR
 *
 * Structure comes from the DECEA coding tables; editorial fields (prose notes,
 * the operational transition altitude, observations) are preserved across runs
 * so re-syncing never overwrites hand-written text. Reads from disk only,
 * except for the ROTAER lookup the first time meta.json is generated.
 */
import fs from "node:fs";
import path from "node:path";
import { fetchAisweb, firstFilledTag, icaoArg, today } from "./lib/aisweb";
import { AISWEB_API } from "../src/aisweb-credentials";
import type {
  AirportGeometry,
  AirportMeta,
  ChartCatalog,
  Leg,
  Procedure,
  ProcedureType,
} from "../src/types";

/** "SID RNAV UMPEL 1A RWY 10" -> { name: "UMPEL 1A", rnav: true } */
function readTitle(title: string): { name: string; rnav: boolean } {
  const body = title
    .replace(/^(SID|STAR|IAC)\s+/, "")
    .replace(/\s+RWY\s+[0-9]{2}[LRC]?(?:\/[0-9]{2}[LRC]?)*$/, "")
    .trim();
  return {
    name: body.replace(/^RNAV\s+/, "").trim(),
    rnav: /^RNAV\b/.test(body),
  };
}

const legFixes = (legs: Leg[]): string[] =>
  legs.map((l) => l.fix).filter((f): f is string => Boolean(f));

function describeLeg(legs: Leg[]): string {
  const last = legs[legs.length - 1];
  const parts: string[] = [];
  if (last?.distance) parts.push(`${last.distance} NM`);
  if (last?.altitude) {
    parts.push(`${last.altitude.replace("+", "≥").replace("-", "≤")} ft`);
  }
  const via = legFixes(legs).slice(1, -1);
  if (via.length > 0) parts.push(`via ${via.join(" → ")}`);
  return parts.join(" · ") || "conforme coding table";
}

function buildProcedures(
  geometry: AirportGeometry,
  existing: Procedure[]
): Procedure[] {
  const previous = new Map(existing.map((p) => [p.id, p]));

  return Object.entries(geometry.procedures)
    .filter(([key]) => key.startsWith("SID|") || key.startsWith("STAR|"))
    .map(([key, geo]): Procedure => {
      const [rawType, , runway] = key.split("|");
      const type = rawType as ProcedureType;
      const { name, rnav } = readTitle(geo.title);
      const id = `${type.toLowerCase()}-${name.replace(/\s+/g, "").toLowerCase()}`;

      const named = Object.entries(geo.transitions).filter(
        ([label]) => label !== "RWY"
      );
      const common = geo.transitions.RWY ?? [];
      const prior: Partial<Procedure> = previous.get(id) ?? {};

      const base: Procedure = {
        id,
        type,
        runway,
        name,
        category: rnav ? "RNAV" : "CONV",
        chartKey: geo.chartKey,
        geometryKey: key,
        notes: prior.notes ?? "",
        fixes: [
          ...new Set(
            Object.values(geo.transitions).flatMap((legs) => legFixes(legs))
          ),
        ],
      };

      if (type === "SID") {
        return {
          ...base,
          commonRoute:
            prior.commonRoute ?? (legFixes(common).join(" → ") || null),
          transitions:
            prior.transitions ??
            named.map(([fix, legs]) => ({ fix, desc: describeLeg(legs) })),
        };
      }

      return {
        ...base,
        entryFixes: prior.entryFixes ?? named.map(([fix]) => fix),
        route: prior.route ?? null,
        // An arrival ends where its longest coded chain ends.
        iaf:
          prior.iaf ??
          Object.values(geo.transitions)
            .map((legs) => legFixes(legs))
            .sort((a, b) => b.length - a.length)[0]
            ?.slice(-1)[0] ??
          null,
      };
    })
    .sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        a.runway.localeCompare(b.runway) ||
        a.name.localeCompare(b.name)
    );
}

async function fetchRotaer(icao: string) {
  const xml = await fetchAisweb("rotaer", icao);

  const freqsOf = (pattern: string): string[] => {
    const block = xml
      .split("<service")
      .find((s) => new RegExp(`<type>(${pattern})</type>`, "i").test(s));
    return block
      ? [...block.matchAll(/<freq[^>]*>(.*?)<\/freq>/g)]
          .map((m) => m[1].trim())
          .filter((f) => f && f !== "121.500")
      : [];
  };

  return {
    name: firstFilledTag(xml, "name"),
    elevation: firstFilledTag(xml, "altFt"),
    fir: firstFilledTag(xml, "fir"),
    runways: [...xml.matchAll(/<rwy>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/rwy>/g)]
      .map((m) => m[1].trim())
      .filter(Boolean),
    dAtis: freqsOf("ATIS|D-ATIS"),
    twr: freqsOf("Torre"),
    app: freqsOf("Controle|Aproxima..o|APP"),
  };
}

const icao = icaoArg("build:content");
const contentDir = path.join("content", icao);
const readJson = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(path.join(contentDir, file), "utf-8")) as T;

const geometry = readJson<AirportGeometry>("geometry.json");
const charts = readJson<ChartCatalog>("charts.json").charts;

const proceduresPath = path.join(contentDir, "procedures.json");
const existing: Procedure[] = fs.existsSync(proceduresPath)
  ? JSON.parse(fs.readFileSync(proceduresPath, "utf-8"))
  : [];

const procedures = buildProcedures(geometry, existing);
fs.writeFileSync(proceduresPath, JSON.stringify(procedures, null, 2) + "\n");

const counts = procedures.reduce<Record<string, number>>((acc, p) => {
  acc[p.type] = (acc[p.type] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `${icao}: procedures.json com ${procedures.length} procedimentos ` +
    `(${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(", ")}).`
);

const metaPath = path.join(contentDir, "meta.json");
if (fs.existsSync(metaPath)) {
  console.log(`${icao}: meta.json já existe — preservado.`);
} else {
  const rotaer = await fetchRotaer(icao);
  // Charts are re-issued per cycle; the newest one carries the current AIRAC.
  const newest = [...charts].sort((a, b) => b.date.localeCompare(a.date))[0];
  const meta: AirportMeta = {
    icao,
    name: rotaer.name || "REVISAR: nome do aeródromo",
    elevation: rotaer.elevation ? `${rotaer.elevation}'` : "REVISAR",
    ta: "REVISAR: ler da carta",
    msa: "REVISAR: ler da carta",
    fir: rotaer.fir || "REVISAR",
    operational: {
      transitionAltitude: 0,
      transitionAltitudeSource: "REVISAR: MOPS IVAO da TMA",
      ivaoWikiUrl: "",
    },
    airac: {
      cycle: newest?.amdt ?? "",
      effective: newest?.date ?? "",
      checkedAt: today(),
      source: `${AISWEB_API}?area=cartas&icaoCode=${icao}`,
    },
    frequencies: {
      dAtis: rotaer.dAtis,
      twr: rotaer.twr,
      app: rotaer.app,
      acc: [],
    },
    runways: rotaer.runways,
    runwaysNote: "",
    observations: [],
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  console.log(`${icao}: meta.json criado — revisar os campos "REVISAR".`);
}
