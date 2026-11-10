/**
 * Runs the whole pipeline for every aerodrome already in content/, in the
 * order the scripts depend on each other:
 *
 *   npm run sync:all
 *
 * 1. sync:airport and build:content per aerodrome (charts, coding tables,
 *    procedures; hand-written fields are preserved);
 * 2. sync:tma, which copies the TMA charts into each aerodrome;
 * 3. sync:airways and sync:rpl, the national data;
 * 4. sync:frequencies, the IVAO division positions;
 * 5. georef:charts, which needs the charts and the airways in place.
 *
 * Stops at the first failure, so a half-synced cycle is never published.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function run(script: string, ...args: string[]) {
  console.log(`\n▶ ${script} ${args.join(" ")}`.trimEnd());
  const result = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}.ts`, ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`✖ ${script} ${args.join(" ")} falhou (código ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

const airports = fs
  .readdirSync("content", { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[A-Z]{4}$/.test(d.name))
  .map((d) => d.name)
  .sort();

for (const icao of airports) {
  run("sync-airport", icao);
  run("build-content", icao);
}
run("sync-tma");
run("sync-airways");
run("sync-rpl");
run("set-network-frequencies");
run("georef-charts");
