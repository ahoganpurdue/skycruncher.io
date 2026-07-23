// Render NARRATIVE_FULL_PIPELINE.md FROM tools/dag/steps/steps_map.json.
//
// The map is the single source of truth; this narrative is a generated view of
// it (numbered walk, one chapter per major-step group, per-step "Visible at this
// point", flags inline, and a footer ruling queue). Edit the map and re-run —
// never hand-edit the .md. Zero deps; standalone (no app imports); cwd-independent.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // tools/dag/steps
const MAP_PATH = path.join(HERE, 'steps_map.json');
const OUT_PATH = path.join(HERE, 'NARRATIVE_FULL_PIPELINE.md');

export function renderNarrative(map) {
  const steps = map.steps;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const children = new Map();
  for (const s of steps) {
    if (s.parent) {
      if (!children.has(s.parent)) children.set(s.parent, []);
      children.get(s.parent).push(s);
    }
  }
  for (const arr of children.values()) arr.sort((a, b) => a.order - b.order);

  // Display number: top-level = global order; child = parentDisplay + '.' + order.
  const displayNum = new Map();
  function assign(id, prefix) {
    const s = byId.get(id);
    const num = prefix ? `${prefix}.${s.order}` : String(s.order);
    displayNum.set(id, num);
    for (const c of children.get(id) || []) assign(c.id, num);
  }
  for (const s of steps.filter((x) => x.parent == null)) assign(s.id, '');

  const L = [];
  const emit = (line = '') => L.push(line);

  // ── Header ──
  emit('# SkyCruncher — Full Pipeline Step Map (narrative)');
  emit();
  emit(
    `> GENERATED from \`tools/dag/steps/steps_map.json\` (map v${map.map_version}, ${map.generated}) ` +
      'by `tools/dag/steps/render_narrative.mjs`. Curated / judgment-derived, validator-gated ' +
      '(NOT drift-gated). Do not hand-edit — edit the map and regenerate.',
  );
  emit();
  emit(map.derivation_note);
  emit();
  emit(
    `Assembled from: ${map.provenance.assembled_from.map((p) => `\`${p}\``).join(', ')}. ` +
      `Rulings: ${map.provenance.rulings}.`,
  );
  emit();

  // ── Body: chapter per major-step group ──
  function badges(s) {
    const parts = [s.kind, s.observed];
    if (s.tags && s.tags.length) parts.push(s.tags.join(', '));
    return parts.filter(Boolean).join(' · ');
  }
  function renderStep(id, depth) {
    const s = byId.get(id);
    const num = displayNum.get(id);
    const h = depth === 0 ? '###' : depth === 1 ? '####' : '#####';
    emit(`${h} ${num}. ${s.title}`);
    emit(`*${badges(s)}*`);
    emit();
    emit(s.narrative);
    emit();
    if (s.visible_at_this_point && s.visible_at_this_point.length) {
      emit(`**Visible at this point:** ${s.visible_at_this_point.join(' · ')}`);
      emit();
    }
    if (s.anchors && s.anchors.length) {
      emit(`*Anchors: ${s.anchors.map((a) => `\`${a}\``).join(', ')}*`);
      emit();
    }
    if (s.flags && s.flags.length) {
      emit('**Flags:**');
      emit();
      for (const f of s.flags) emit(`- ${f}`);
      emit();
    }
    for (const c of children.get(id) || []) renderStep(c.id, depth + 1);
  }

  for (const ch of map.chapters) {
    emit('---');
    emit();
    emit(`## Chapter ${ch.n} — ${ch.title}  *(segment ${ch.segment})*`);
    emit();
    if (ch.note) {
      emit(`> ${ch.note}`);
      emit();
    }
    const [lo, hi] = ch.orders;
    const tops = steps
      .filter((s) => s.parent == null && s.order >= lo && s.order <= hi)
      .sort((a, b) => a.order - b.order);
    for (const s of tops) renderStep(s.id, 0);
  }

  // ── Footer: owner ruling queue ──
  emit('---');
  emit();
  emit('## Owner ruling queue');
  emit();
  emit('Every `OWNER RULING NEEDED` flag in the map, in walk order. These are the open scope-boundary calls for the owner; each stays surfaced here until ruled.');
  emit();
  const queue = [];
  for (const s of steps.sort((a, b) => cmpDisplay(displayNum.get(a.id), displayNum.get(b.id)))) {
    for (const f of s.flags || []) {
      if (f.includes('OWNER RULING NEEDED')) queue.push({ id: s.id, num: displayNum.get(s.id), text: f });
    }
  }
  let i = 1;
  for (const q of queue) emit(`${i++}. **${q.num} \`${q.id}\`** — ${q.text}`);
  emit();
  emit(`_${queue.length} open owner ruling(s)._`);
  emit();

  return L.join('\n');
}

// Numeric-aware compare of dotted display numbers ("7" < "7.1" < "7.2" < "8").
function cmpDisplay(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('render_narrative.mjs')) {
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const md = renderNarrative(map);
  writeFileSync(OUT_PATH, md, 'utf8');
  process.stdout.write(`NARRATIVE_FULL_PIPELINE.md written: ${map.steps.length} steps, ${map.chapters.length} chapters\n`);
}
