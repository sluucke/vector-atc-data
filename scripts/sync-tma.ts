/**
 * Syncs the charts DECEA publishes per TMA rather than per aerodrome, and
 * copies each one into every aerodrome the TMA serves:
 *
 * - ARC, the area chart: airways, fixes and minimum altitudes of the TMA;
 * - ATCSMAC, the surveillance minimum altitude chart: the lowest altitudes a
 *   radar controller may vector to, sector by sector;
 * - REA, the special VFR routes for aeroplanes.
 *
 *   npm run sync:tma
 *
 * ARC and ATCSMAC come from the AISWEB API under the TMA's own code (SBWR for
 * Brasília). REA sheets never appear in that API; they only exist in the HTML
 * table at aisweb.decea.mil.br/?i=cartas&p=visuais, one row per TMA.
 */
import fs from "node:fs";
import path from "node:path";
import { download, fetchAisweb, fetchText, slug, tag } from "./lib/aisweb";
import type { Chart, ChartCatalog } from "../src/types";

const VISUAL_INDEX = "https://aisweb.decea.mil.br/?i=cartas&p=visuais";

/** TMA code (as AISWEB files ARC and ATCSMAC) to the aerodromes it serves. */
const TMA_AIRPORTS: Record<string, string[]> = {
  SBWF: ["SBRF"],
  SBWH: ["SBBH", "SBCF"],
  SBWJ: ["SBRJ"],
  SBWR: ["SBBR"],
  SBXF: ["SBFL"],
  SBXN: ["SBGO"],
  SBXP: ["SBSP"],
  SBXS: ["SBSV"],
  SBXT: ["SBNT", "SBSG"],
};

interface Sheet {
  tma: string;
  type: string;
  key: string;
  name: string;
  amdt: string;
  date: string;
  href: string;
}

async function apiSheets(tma: string): Promise<Sheet[]> {
  const xml = await fetchAisweb("cartas", tma);
  return xml
    .split("<item ")
    .slice(1)
    .map((item) => ({ type: tag(item, "tipo"), item }))
    .filter(({ type }) => type === "ARC" || type === "ATCSMAC")
    .map(({ type, item }) => ({
      tma,
      type,
      key: `${type.toLowerCase()}-${tma.toLowerCase()}`,
      name: tag(item, "nome") || `${type} ${tma}`,
      amdt: tag(item, "amdt"),
      date: tag(item, "dt"),
      href: tag(item, "link").replace(/&amp;/g, "&"),
    }));
}

/** REA rows of the visual-charts page: "CCV REA WJ1-RIO DE JANEIRO" -> SBWJ */
async function reaSheets(): Promise<Sheet[]> {
  const html = await fetchText(VISUAL_INDEX);
  const rows = [
    ...html.matchAll(/<tr><td data-order="REA">REA<\/td>[\s\S]*?<\/tr>/g),
  ].map((m) => m[0]);

  return rows.flatMap((row) => {
    const name = row.match(/data-order="(CCV[^"]*)"/i)?.[1];
    const href = row.match(/href="([^"]+\.pdf)"/)?.[1];
    if (!name || !href) return [];
    const code = name.toUpperCase().match(/REA\s+([A-Z]+\d*)-/)?.[1]?.toLowerCase();
    // The sheet code is the TMA code without "SB", sometimes numbered.
    const tma = Object.keys(TMA_AIRPORTS).find(
      (t) => code && code.replace(/\d+$/, "") === t.slice(2).toLowerCase()
    );
    if (!tma || !code) return [];
    const dates = [...row.matchAll(/data-order="(\d{4})\/(\d{2})\/(\d{2})"/g)];
    const last = dates[dates.length - 1];
    return [
      {
        tma,
        type: "REA",
        key: `rea-${code}`,
        name: name.replace(/^CCV\s+REA\s+/i, ""),
        amdt: row.match(/data-search="(\d{4}A\d)"/)?.[1] ?? "",
        date: last ? `${last[1]}-${last[2]}-${last[3]}` : "",
        href,
      },
    ];
  });
}

const sheets = [
  ...(await Promise.all(Object.keys(TMA_AIRPORTS).map(apiSheets))).flat(),
  ...(await reaSheets()),
];

for (const sheet of sheets) {
  const buffer = await download(sheet.href);
  const file = `${sheet.key}-${slug(sheet.name)}.pdf`;

  for (const icao of TMA_AIRPORTS[sheet.tma]) {
    const catalogPath = path.join("content", icao, "charts.json");
    if (!fs.existsSync(catalogPath)) {
      console.warn(`  ${icao}: sem charts.json — rode sync:airport antes`);
      continue;
    }
    const chartsDir = path.join("charts", icao);
    fs.mkdirSync(chartsDir, { recursive: true });
    fs.writeFileSync(path.join(chartsDir, file), buffer);

    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as ChartCatalog;
    const chart: Chart = {
      key: sheet.key,
      type: sheet.type,
      name: sheet.name,
      code: sheet.tma,
      amdt: sheet.amdt,
      date: sheet.date,
      file: `/charts/${icao}/${file}`,
    };
    catalog.charts = [
      ...catalog.charts.filter((c) => c.key !== sheet.key),
      chart,
    ].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  }
  console.log(`  ${sheet.type.padEnd(7)} ${sheet.tma} ${sheet.name} (${sheet.amdt}) → ${TMA_AIRPORTS[sheet.tma].join(", ")}`);
}
