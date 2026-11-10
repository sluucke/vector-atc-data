/**
 * Packs content/ and charts/ into the assets of one release:
 *
 *   npm run release:package -- data-2026-11-10
 *
 *   dist/content.tar.gz   every JSON under content/
 *   dist/charts.tar       every PDF under charts/ (already compressed)
 *   dist/manifest.json    release name, date, AIRAC cycles and counts
 *
 * Vector ATC downloads these from releases/latest at build time and unpacks
 * them into its own content/ and public/charts/. Fails if a catalog points at
 * a PDF that is not on disk, so a release never ships a broken link.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AirportMeta, ChartCatalog } from "../src/types";

const today = new Date().toISOString().slice(0, 10);
const release = process.argv[2] ?? `data-${today}`;

const airports = fs
  .readdirSync("content", { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[A-Z]{4}$/.test(d.name))
  .map((d) => d.name)
  .sort();

const missing: string[] = [];
let charts = 0;
const airac: Record<string, string> = {};

for (const icao of airports) {
  const catalog = JSON.parse(
    fs.readFileSync(path.join("content", icao, "charts.json"), "utf8")
  ) as ChartCatalog;
  for (const chart of catalog.charts) {
    charts++;
    if (!fs.existsSync(path.join(".", chart.file))) missing.push(chart.file);
  }
  const metaFile = path.join("content", icao, "meta.json");
  if (fs.existsSync(metaFile)) {
    airac[icao] = (JSON.parse(fs.readFileSync(metaFile, "utf8")) as AirportMeta).airac.cycle;
  }
}

if (missing.length > 0) {
  console.error(`${missing.length} carta(s) sem PDF em charts/:\n${missing.map((f) => `  ${f}`).join("\n")}`);
  console.error("Rode npm run sync:all (ou o sync do aeródromo) antes de empacotar.");
  process.exit(1);
}

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist");

// Relative paths only: GNU tar on Windows reads "C:" as a remote host.
execFileSync("tar", ["-czf", "dist/content.tar.gz", "-C", "content", "."], { stdio: "inherit" });
execFileSync("tar", ["-cf", "dist/charts.tar", "-C", "charts", "."], { stdio: "inherit" });

const manifest = {
  release,
  generatedAt: new Date().toISOString(),
  airports,
  airac,
  charts,
  assets: Object.fromEntries(
    ["content.tar.gz", "charts.tar"].map((name) => [name, fs.statSync(path.join("dist", name)).size])
  ),
};
fs.writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `${release}: ${airports.length} aeródromos, ${charts} cartas. ` +
    `content.tar.gz ${mb(manifest.assets["content.tar.gz"])}, charts.tar ${mb(manifest.assets["charts.tar"])}.`
);
