/**
 * AISWEB (DECEA) API credentials.
 *
 * The fallback pair is the one AISWEB's own public website ships in its client
 * bundle, so it is not a secret. Set AISWEB_API_KEY and AISWEB_API_PASS to use
 * a pair registered for this project instead. Shared by the server routes and
 * the sync scripts so the pair lives in one place.
 */
export const AISWEB_API = "https://aisweb.decea.mil.br/api/";

const PUBLIC_KEY = "1587263166";
const PUBLIC_PASS = "3199249e-755b-1033-a49b-72567f175e3a";

export function aiswebCredentials(): { apiKey: string; apiPass: string } {
  return {
    apiKey: process.env.AISWEB_API_KEY || PUBLIC_KEY,
    apiPass: process.env.AISWEB_API_PASS || PUBLIC_PASS,
  };
}

/** Builds an AISWEB API URL for one area ("cartas", "rotaer", "met", …). */
export function aiswebUrl(area: string, icao: string): URL {
  const { apiKey, apiPass } = aiswebCredentials();
  const url = new URL(AISWEB_API);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("apiPass", apiPass);
  url.searchParams.set("area", area);
  url.searchParams.set("icaoCode", icao.toUpperCase());
  return url;
}
