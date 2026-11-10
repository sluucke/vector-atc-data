/**
 * Reads DECEA coding-table PDFs as rows of cells.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

interface Fragment {
  x: number;
  width: number;
  s: string;
}

/**
 * Turns one line's text fragments into table cells.
 *
 * The generator splits words wherever it likes — a title can arrive as "S",
 * "ID", "RNAV", "EVKOX", "4", "A" — so fragments are rejoined by how far apart
 * they sit: touching means one word, a space's width means one phrase, and a
 * column's width means a new cell. Columns that overlap in x, which happens
 * where the true and magnetic courses are printed out of order, always start a
 * new cell.
 */
export function toCells(items: Fragment[]): string[] {
  const GLUE = 0.5;
  const COLUMN = 6;
  const cells: string[] = [];
  let end: number | null = null;

  for (const item of items) {
    const gap = end === null ? Infinity : item.x - end;
    if (gap > COLUMN || gap < -GLUE) cells.push(item.s);
    else if (gap < GLUE) cells[cells.length - 1] += item.s;
    else cells[cells.length - 1] += ` ${item.s}`;
    end = item.x + item.width;
  }

  return cells;
}

/** Every line of every page, top to bottom, as cells. */
export async function pdfRows(buffer: Buffer): Promise<string[][]> {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  const pages: string[][][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const byY = new Map<number, Fragment[]>();

    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const key = [...byY.keys()].find((k) => Math.abs(k - y) <= 4) ?? y;
      const line = byY.get(key) ?? [];
      line.push({
        x: item.transform[4],
        width: item.width ?? 0,
        s: item.str.trim(),
      });
      byY.set(key, line);
    }

    pages.push(
      [...byY.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, items]) => toCells(items.sort((a, b) => a.x - b.x)))
    );
  }

  return pages.flat();
}

