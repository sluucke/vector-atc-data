/**
 * Tells whether a sync changed anything worth publishing.
 *
 *   npm run check:changed
 *
 * Every run stamps syncedAt/checkedAt, so a plain git diff always differs.
 * This compares each JSON file under content/ with the last commit after
 * dropping those stamps. In GitHub Actions it also writes `changed=true|false`
 * to the step output.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const STAMPS = new Set(["syncedAt", "checkedAt"]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !STAMPS.has(key))
        .map(([key, v]) => [key, strip(v)])
    );
  }
  return value;
}

function committed(file: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${file}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function jsonFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return jsonFiles(full);
    return entry.name.endsWith(".json") ? [full] : [];
  });
}

const tracked = execFileSync("git", ["ls-files", "content"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.endsWith(".json"));
const files = [...new Set([...jsonFiles("content"), ...tracked])].sort();

const changed = files.filter((file) => {
  const before = committed(file);
  const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (before === null || after === null) return before !== after;
  return JSON.stringify(strip(JSON.parse(before))) !== JSON.stringify(strip(JSON.parse(after)));
});

if (changed.length === 0) console.log("Nada mudou além das datas de sincronização.");
else console.log(`Mudaram ${changed.length} arquivo(s):\n${changed.map((f) => `  ${f}`).join("\n")}`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length > 0}\n`);
}
