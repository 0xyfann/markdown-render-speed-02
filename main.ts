// Driver for the markdown-render-speed-02 entry.
// Reads every case from /input/cases.json, renders each markdown string with
// parse() from ./parse.js, and writes the HTML strings, in order, to
// /output/html.json. Runs as `node /bot/main.ts` on Node 22 (type stripping,
// erasable syntax only). MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR may override
// the two directories for local runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
