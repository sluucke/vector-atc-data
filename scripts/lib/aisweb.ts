/**
 * Network and text helpers shared by the sync scripts.
 */
import { aiswebUrl } from "../../src/aisweb-credentials";

const HEADERS = { "User-Agent": "vector-atc/1.0" };

/**
 * Chart types published per TMA and copied in by sync:tma. sync:airport only
 * knows the aerodrome's own charts, so it keeps these when it rewrites.
 */
export const TMA_CHART_TYPES = new Set(["ARC", "ATCSMAC", "REA"]);

/** GETs one AISWEB API area as text. */
export async function fetchAisweb(area: string, icao: string): Promise<string> {
  const res = await fetch(aiswebUrl(area, icao), { headers: HEADERS });
  if (!res.ok) throw new Error(`AISWEB ${area} ${icao}: ${res.status}`);
  return res.text();
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.text();
}

export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** First occurrence of an XML tag, CDATA unwrapped. */
export function tag(xml: string, name: string): string {
  const m = xml.match(
    new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`)
  );
  return m ? m[1].trim() : "";
}

/**
 * ROTAER repeats tag names across blocks, some of them empty, so take the
 * first occurrence that actually carries a value.
 */
export function firstFilledTag(xml: string, name: string): string {
  const all = [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))];
  return (
    all
      .map((m) => m[1].replace("<![CDATA[", "").replace("]]>", "").trim())
      .find(Boolean) ?? ""
  );
}

/** "Florianópolis / Hercílio Luz" -> "florianopolis-hercilio-luz" */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Reads the four-letter ICAO code from argv, or exits with the usage line. */
export function icaoArg(script: string): string {
  const icao = (process.argv[2] ?? "").toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) {
    console.error(`Usage: npm run ${script} -- <ICAO>`);
    process.exit(1);
  }
  return icao;
}
