#!/usr/bin/env node
/**
 * Anti-simulation guardrail for the BUILT bundle (dist/).
 * Scans every emitted JS chunk for forbidden patterns that may have leaked
 * in via a transitive dependency or accidental import.
 *
 * Run AFTER `npm run build`. CI step: `npm run check:no-sim:dist`.
 *
 * Allowlist: scripts/anti-sim-allowlist.json — entries with `dist: true`
 * and `pattern` will be tolerated (require reason + ref like the source one).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = "dist";
if (!existsSync(DIST)) {
  console.error(`❌ ${DIST}/ not found — run \`npm run build\` first.`);
  process.exit(1);
}

const PATTERNS = [
  { id: "MATH_RANDOM", re: /Math\.random\s*\(/g },
  { id: "SYNTHETIC",   re: /\bsynthetic\b/gi },
  { id: "SIMULATE",    re: /\bsimulat(?:e|ed|ing|ion)\b/gi },
  { id: "FAKE_DATA",   re: /\bfake[_-]?(?:data|signal|value|vital)s?\b/gi },
  { id: "MOCK_DATA",   re: /\bmock[_-]?(?:data|signal|value|vital)s?\b/gi },
];

let allowlist = [];
const ALLOW_PATH = "scripts/anti-sim-allowlist.json";
if (existsSync(ALLOW_PATH)) {
  const raw = JSON.parse(readFileSync(ALLOW_PATH, "utf8"));
  allowlist = (raw.entries || []).filter(e => e.dist === true);
  for (const e of allowlist) {
    if (!e.reason || !e.ref || !e.pattern) {
      console.error(`❌ dist allowlist entry missing reason/ref/pattern: ${JSON.stringify(e)}`);
      process.exit(1);
    }
  }
}
function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
const usedEntries = new Set();
function isAllowed(id, fileRel) {
  let allowed = false;
  allowlist.forEach((e, idx) => {
    if (e.pattern !== id) return;
    if (e.file && !globToRe(e.file).test(fileRel)) return;
    allowed = true;
    usedEntries.add(idx);
  });
  return allowed;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|cjs)$/.test(name) && !/\.map$/.test(name)) yield p;
  }
}

const violations = [];
let scannedFiles = 0;
let scannedBytes = 0;
for (const file of walk(DIST)) {
  scannedFiles++;
  const text = readFileSync(file, "utf8");
  scannedBytes += text.length;
  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (matches && matches.length && !isAllowed(id, relative(".", file).replace(/\\/g, "/"))) {
      violations.push({ file: relative(".", file).replace(/\\/g, "/"), id, count: matches.length, sample: matches[0] });
    }
  }
}

const staleEntries = allowlist.filter((_, idx) => !usedEntries.has(idx));
if (staleEntries.length) {
  console.error("\n❌ STALE DIST ALLOWLIST ENTRIES (no matching pattern in dist/) — delete them:\n");
  for (const e of staleEntries) console.error(`  ${e.file} [${e.pattern}] ref=${e.ref}`);
  process.exit(1);
}

if (violations.length) {
  console.error("\n❌ DIST ANTI-SIMULATION GUARDRAIL FAILED\n");
  for (const v of violations) {
    console.error(`  [${v.id}] ${v.file} — ${v.count} match(es), sample: "${v.sample}"`);
  }
  console.error(`\nThe built bundle contains forbidden patterns. If a transitive dep is responsible, allowlist it in ${ALLOW_PATH} with { dist:true, pattern, reason, ref } and document why it cannot reach the PPG pipeline.\n`);
  process.exit(1);
}
console.log(`✅ Dist guardrail passed (${scannedFiles} files / ${(scannedBytes / 1024).toFixed(1)} KB scanned).`);
