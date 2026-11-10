/**
 * Writes the IVAO Brazil division's published position frequencies into each
 * aerodrome's meta.json.
 *
 * These are the frequencies a controller actually works on the network, which
 * are not always the ones printed on the DECEA charts, so they are stored with
 * their own label rather than mixed into the chart data.
 */
import fs from "node:fs";
import path from "node:path";
import type { AirportMeta } from "../src/types";

interface Center {
  label: string;
  primary: string[];
  sectors: string[];
}

interface Approach {
  /** IVAO callsign of the approach position, when known. */
  position: string | null;
  /** Division frequencies; null keeps whatever meta.json already has. */
  frequencies: string[] | null;
  center: keyof typeof CENTERS;
  /** Overrides the default note shown under the frequency cards. */
  source?: string;
}

const CENTERS: Record<"SBBS" | "SBCW" | "SBRE", Center> = {
  SBBS: {
    label: "Centro Brasília (SBBS_CTR)",
    primary: ["123.000"],
    sectors: ["135.150", "135.900", "135.550", "134.000", "133.750", "135.000"],
  },
  SBCW: {
    label: "Centro Curitiba (SBCW_CTR)",
    primary: ["124.000"],
    sectors: ["126.950", "128.150", "125.350", "126.100", "133.800", "124.900", "135.850"],
  },
  SBRE: {
    label: "Centro Recife (SBRE_CTR)",
    primary: ["126.000"],
    sectors: ["135.800", "135.250", "126.700", "135.300", "134.800", "126.850"],
  },
};

/** APP position and its frequencies, as published by the division. */
const APPROACH: Record<string, Approach> = {
  SBBR: { position: "SBWR_APP", frequencies: ["129.600"], center: "SBBS" },
  SBSP: { position: "SBXP_APP", frequencies: ["129.750"], center: "SBBS" },
  SBRJ: {
    position: "SBWJ_APP",
    frequencies: [
      "119.000",
      "135.600",
      "120.550",
      "126.200",
      "129.200",
      "119.350",
      "132.500",
    ],
    center: "SBCW",
  },
  // Goiânia is worked from the Anápolis TMA. The charts print no APP
  // frequency for it, so the list stays empty rather than guessed.
  SBGO: {
    position: "SBXN_APP",
    frequencies: null,
    center: "SBBS",
    source:
      "Centro conforme as posições da divisão IVAO Brasil; sem frequência de APP publicada na carta",
  },
  SBFL: { position: "SBXF_APP", frequencies: ["119.650", "119.500"], center: "SBCW" },
  // Belo Horizonte: both aerodromes share one TMA, and the division's callsign
  // for that approach position is not known here, so the charts stand.
  SBBH: {
    position: null,
    frequencies: null,
    center: "SBBS",
    source:
      "Centro conforme as posições da divisão IVAO Brasil; APP conforme a carta DECEA",
  },
  SBCF: {
    position: null,
    frequencies: null,
    center: "SBBS",
    source:
      "Centro conforme as posições da divisão IVAO Brasil; APP conforme a carta DECEA",
  },
  // Natal's approach frequencies come from the DECEA chart, not from the
  // division, so this script must not overwrite them.
  SBNT: {
    position: "SBXT_APP",
    frequencies: null,
    center: "SBRE",
    source:
      "Centro conforme as posições da divisão IVAO Brasil; APP conforme a carta DECEA",
  },
  SBSG: {
    position: "SBXT_APP",
    frequencies: null,
    center: "SBRE",
    source:
      "Centro conforme as posições da divisão IVAO Brasil; APP conforme a carta DECEA",
  },
  SBSV: { position: "SBXS_APP", frequencies: ["119.350", "120.800"], center: "SBRE" },
  // Recife has no APP frequency published to us yet, so it keeps an empty list
  // rather than borrowing another TMA's.
  SBRF: { position: null, frequencies: [], center: "SBRE" },
};

for (const [icao, app] of Object.entries(APPROACH)) {
  const file = path.join("content", icao, "meta.json");
  const meta = JSON.parse(fs.readFileSync(file, "utf8")) as AirportMeta;
  const center = CENTERS[app.center];

  meta.frequencies = {
    ...meta.frequencies,
    app: app.frequencies ?? meta.frequencies.app,
    acc: center.primary,
    accExtended: center.sectors,
  };
  meta.frequencies.network = {
    source:
      app.source ?? "Frequências das posições da divisão IVAO Brasil",
    app: app.position,
    acc: `${app.center}_CTR`,
  };

  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
  console.log(
    `${icao}  APP ${app.position ?? "—"} ${(app.frequencies ?? meta.frequencies.app).join(" ") || "—"}  ` +
      `| ${center.label} ${center.primary.join(" ")}`
  );
}
