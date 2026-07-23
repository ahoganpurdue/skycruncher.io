#!/usr/bin/env node
/**
 * Regenerate ops_map.js (the load-as-global script wrapper) from ops_map.json.
 *
 * ops_map.json is CANONICAL — the curated operations map, hand-derived from
 * docs/OPERATIONS_MAP.md (§1 actor graph + §3 wait graph). The #ops tab reads
 * it synchronously as a global (like the flow tab's flow_edge_semantics.js), so
 * it never parses markdown or blocks on a fetch at render time. The .js is
 * GENERATED — never edit it by hand.
 *
 * Run after any ops_map.json edit:
 *   node tools/theses/dashboard/ui/gen_ops_map.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(dir, 'ops_map.json'), 'utf8');
JSON.parse(raw); // validate — a broken map must fail loudly here, not render wrong

const out =
  `/* GENERATED from ops_map.json by gen_ops_map.mjs — DO NOT EDIT.\n` +
  `   Source: docs/OPERATIONS_MAP.md (DRAFT v0). Regenerate: node tools/theses/dashboard/ui/gen_ops_map.mjs */\n` +
  `window.__OPS_MAP__ = ${raw.trim()};\n`;

writeFileSync(join(dir, 'ops_map.js'), out);
console.log('wrote ops_map.js');
