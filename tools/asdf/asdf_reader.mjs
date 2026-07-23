/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ASDF READER — dependency-free subset reader for the SkyCruncher INGESTOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Ledger: NEITHER (pure parse — no DOM, no engine reach-back, no Rust, no deps).
 *
 * Reads Advanced Scientific Data Format (STScI; JWST/Roman) files WITHOUT the
 * Python `asdf` library, so a Node-side ingestor can inspect a file's tree +
 * binary ndarray blocks. Two dialects are in scope:
 *   (a) OUR OWN writer's deterministic emission
 *       (src/engine/pipeline/export/asdf_writer.ts) — a fully-known subset.
 *   (b) roman_datamodels' `asdf.AsdfFile.write_to` emission (Roman L2) — the
 *       asdf library's PyYAML block-style dump.
 *
 * This is a SUBSET parser. It parses exactly the YAML 1.1 constructs both writers
 * emit, and it FAILS HONESTLY (throws a labelled error naming the construct + the
 * 1-based line) on anything outside that subset — it NEVER guesses. The supported
 * subset is enumerated in `tools/asdf/INGEST_README.md` and mirrored in the
 * SUPPORTED / UNSUPPORTED tables below.
 *
 * ── SUPPORTED YAML subset ─────────────────────────────────────────────────────
 *   • the leading `#ASDF` / `#ASDF_STANDARD` comment lines + `%YAML` / `%TAG`
 *     directives + the single `--- [!tag]` document-start
 *   • block mappings (`key: value`, 2-space indent steps); bare or quoted keys
 *   • block sequences (`- item`, incl. `- key: v` compact-mapping items and
 *     `- !tag` tagged items)
 *   • flow sequences `[a, b, [c, d]]` and flow mappings `{k: v, k2: v2}` (nested)
 *   • tags: short `!core/ndarray-1.1.0` and verbose `!<tag:stsci.edu:gwcs/…>`
 *     on mappings, sequences AND scalars (`!unit/unit-1.0.0 pixel`)
 *   • YAML anchors `&id` (record) and aliases `*id` (resolve to the anchored node)
 *   • scalars: `null`/`~`, `true`/`false`, ints, floats (incl. `1.0e-8`),
 *     double- and single-quoted strings, plain (unquoted) scalars
 *   • binary blocks (magic `\xd3BLK`, 48-byte header, BE sizes) — via block index
 *     when present, else a deterministic sequential header walk
 *   • the trailing `#ASDF BLOCK INDEX` document (parsed, but the header walk is
 *     authoritative — the index is only cross-checked)
 *
 * ── EXPLICITLY UNSUPPORTED (throws, never guessed) ────────────────────────────
 *   • block scalars (`|`, `>`), multi-line plain scalars
 *   • complex/explicit keys (`? …`), merge keys (`<<`), YAML sets (`!!set`)
 *   • multiple YAML documents in the tree region (only the first `---` is read)
 *   • compressed binary blocks (compression != `\0\0\0\0`) — flagged, not decoded
 *   • tab indentation (YAML forbids it; we reject rather than misalign)
 *
 * CLI:  node tools/asdf/asdf_reader.mjs <file.asdf> [--tree|--blocks|--json]
 */

import fs from 'node:fs';

const BLOCK_MAGIC = Uint8Array.from([0xd3, 0x42, 0x4c, 0x4b]); // "\xd3BLK"

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Parse an ASDF file from disk.
 * @returns {{
 *   comments: string[], directives: string[], standardVersion: string|null,
 *   tree: any, blocks: AsdfBlock[], readBlock: (i:number)=>Buffer,
 *   readNdarray: (node:any)=>{shape:number[], dtype:string, data:Buffer}
 * }}
 */
export function readAsdfFile(filePath) {
    return parseAsdf(fs.readFileSync(filePath), filePath);
}

/** @typedef {{index:number, offset:number, dataStart:number, allocatedSize:number, usedSize:number, dataSize:number, compression:string, flags:number}} AsdfBlock */

/**
 * Parse an ASDF byte buffer.
 * @param {Buffer} buf
 * @param {string} [label] filename for error messages
 */
export function parseAsdf(buf, label = '<buffer>') {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 5 || buf.toString('latin1', 0, 5) !== '#ASDF') {
        throw new AsdfError(`not an ASDF file (missing '#ASDF' magic) in ${label}`);
    }

    // ── locate the tree region: from the start up to the first binary block ─────
    const firstBlockOffset = findFirstBlock(buf);
    const treeRegionEnd = firstBlockOffset >= 0 ? firstBlockOffset : buf.length;
    const treeText = buf.toString('utf8', 0, treeRegionEnd);

    const { comments, directives, standardVersion, yamlText, docTagRest } =
        splitHeader(treeText, label);

    // ── parse the YAML tree ─────────────────────────────────────────────────────
    const tree = parseYamlDocument(yamlText, docTagRest, label);

    // ── parse binary blocks (sequential header walk; index cross-checked) ───────
    const blocks = firstBlockOffset >= 0 ? walkBlocks(buf, firstBlockOffset, label) : [];

    const readBlock = (i) => {
        if (i < 0 || i >= blocks.length) {
            throw new AsdfError(`block ${i} out of range (file has ${blocks.length} block(s)) in ${label}`);
        }
        const b = blocks[i];
        if (b.compression !== 'none') {
            throw new AsdfError(
                `block ${i} uses compression '${b.compression}' — UNSUPPORTED (this reader does not decompress) in ${label}`
            );
        }
        return buf.subarray(b.dataStart, b.dataStart + b.usedSize);
    };

    const readNdarray = (node) => resolveNdarray(node, readBlock, label);

    return { comments, directives, standardVersion, tree, blocks, readBlock, readNdarray };
}

// ── header / directive parsing ──────────────────────────────────────────────────

function splitHeader(text, label) {
    const lines = text.split('\n');
    const comments = [];
    const directives = [];
    let standardVersion = null;
    let i = 0;
    let docTagRest = '';

    for (; i < lines.length; i++) {
        const raw = lines[i];
        if (raw.startsWith('#ASDF_STANDARD')) {
            standardVersion = raw.slice('#ASDF_STANDARD'.length).trim() || null;
            comments.push(raw);
            continue;
        }
        if (raw.startsWith('#')) { comments.push(raw); continue; }
        if (raw.startsWith('%')) { directives.push(raw.trim()); continue; }
        if (raw.startsWith('---')) {
            docTagRest = raw.slice(3).trim(); // the `!core/asdf-1.1.0` doc tag, if any
            i++;
            break;
        }
        if (raw.trim() === '') continue;
        // First non-comment, non-directive, non-`---` line: this writer always
        // has a `---`; its absence means an unexpected layout → fail honestly.
        throw new AsdfError(`expected a YAML document start ('---') before content, got: ${JSON.stringify(raw)} in ${label}`);
    }

    const yamlText = lines.slice(i).join('\n');
    return { comments, directives, standardVersion, yamlText, docTagRest };
}

// ═══════════════════════════════════════════════════════════════════════════════
// YAML SUBSET PARSER
// ═══════════════════════════════════════════════════════════════════════════════
// Indentation-driven recursive-descent over a pre-tokenised line list. Anchors are
// recorded and aliases resolved. Tagged nodes are wrapped as { __tag__, __value__ }
// so a caller can inspect the tag (needed for the gwcs transform inventory) while
// still reading the value. Plain (untagged) values are returned as native JS.

/** A tagged node wrapper. `__tag__` is the raw tag string (with a leading '!'). */
export function isTagged(v) {
    return v != null && typeof v === 'object' && typeof v.__tag__ === 'string' && '__value__' in v;
}
function tagged(tag, value) { return { __tag__: tag, __value__: value }; }

/** Unwrap a (possibly-tagged) node to its underlying value. */
export function untag(v) { return isTagged(v) ? v.__value__ : v; }

function parseYamlDocument(yamlText, docTagRest, label) {
    // Build a list of significant LOGICAL lines with their indentation, stripping
    // blank lines + end-of-tree markers and MERGING multi-line flow collections
    // (asdf line-wraps long `{…}` / `[…]` flow nodes across indented continuation
    // lines — e.g. `wcsinfo: {…,` \n `  …}`). Reject tab indentation up front.
    const rawLines = yamlText.split('\n');
    const lines = [];
    let n = 0;
    while (n < rawLines.length) {
        let first = rawLines[n];
        if (first.endsWith('\r')) first = first.slice(0, -1);
        if (first.trim() === '') { n++; continue; }
        if (first.trim() === '...') break; // end-of-tree marker
        if (/^ *\t/.test(first)) {
            throw new AsdfError(`tab indentation is UNSUPPORTED (YAML forbids tabs) at line ${n + 1} in ${label}`);
        }
        const lineNo = n + 1;
        const indent = first.length - first.trimStart().length;

        // Accumulate continuation lines while the flow brackets stay unbalanced.
        // A YAML flow newline folds to a space, so join continuations with ' '.
        let buf = first;
        while (flowDepth(buf) > 0) {
            n++;
            if (n >= rawLines.length) {
                throw new AsdfError(`unterminated flow collection starting at line ${lineNo} in ${label}`);
            }
            let cont = rawLines[n];
            if (cont.endsWith('\r')) cont = cont.slice(0, -1);
            buf += ' ' + cont.trim();
        }
        n++;

        const text = stripComment(buf).trim();
        if (text === '') continue;
        lines.push({ indent, text, lineNo });
    }

    const ctx = { lines, pos: 0, anchors: new Map(), label };

    // The document node may itself be a mapping (our writer) — the `!core/asdf`
    // doc tag is metadata we retain but the body is a plain mapping.
    if (ctx.lines.length === 0) return docTagRest ? tagged('!' + stripBang(docTagRest), {}) : {};

    const body = parseNode(ctx, 0);
    if (ctx.pos < ctx.lines.length) {
        const l = ctx.lines[ctx.pos];
        throw new AsdfError(`unexpected trailing content at line ${l.lineNo}: ${JSON.stringify(l.text)} in ${label} (multiple documents in the tree region are UNSUPPORTED)`);
    }
    // Attach the document tag as a hidden marker (non-enumerable) so it never
    // pollutes tree walks but is available for provenance.
    if (docTagRest && body && typeof body === 'object') {
        Object.defineProperty(body, '__doc_tag__', { value: '!' + stripBang(docTagRest), enumerable: false });
    }
    return body;
}

/**
 * Parse the node beginning at ctx.pos, whose content is indented at `minIndent`.
 * Dispatches on the first line's shape: block sequence, block mapping, or (when
 * the value is inline) a scalar/flow.
 */
function parseNode(ctx, minIndent) {
    const line = ctx.lines[ctx.pos];
    if (!line) return null;
    if (line.indent < minIndent) return null;

    if (line.text.startsWith('- ') || line.text === '-') {
        return parseBlockSequence(ctx, line.indent);
    }
    return parseBlockMapping(ctx, line.indent);
}

function parseBlockSequence(ctx, indent) {
    const seq = [];
    while (ctx.pos < ctx.lines.length) {
        const line = ctx.lines[ctx.pos];
        if (line.indent !== indent) {
            if (line.indent < indent) break;
            throw new AsdfError(`bad sequence indentation at line ${line.lineNo} (expected ${indent}, got ${line.indent}) in ${ctx.label}`);
        }
        if (!(line.text === '-' || line.text.startsWith('- '))) break;

        const afterDash = line.text === '-' ? '' : line.text.slice(2);
        seq.push(parseSeqItem(ctx, indent, afterDash, line));
    }
    return seq;
}

/**
 * A single `- …` item. The content after the dash may be: empty (nested block on
 * following lines), a compact mapping (`- key: v` — more keys align under the
 * dash+2 column), a tagged node, a flow, or a scalar.
 */
function parseSeqItem(ctx, dashIndent, afterDash, line) {
    const contentCol = dashIndent + 2; // column where `- ` content starts

    // `- ` with nothing after → the item is a nested block on the next lines.
    if (afterDash.trim() === '') {
        ctx.pos++;
        const next = ctx.lines[ctx.pos];
        if (next && next.indent > dashIndent) return parseNode(ctx, next.indent);
        return null;
    }

    // Handle an anchor/tag prefix on the item, then re-dispatch on the remainder.
    let anchor = null, tag = null, rest = afterDash;
    ({ anchor, tag, rest } = takeAnchorAndTag(rest));

    // Compact mapping item: `- key: value` (detect an unquoted/ quoted key + colon).
    if (tag == null && isMappingStart(rest)) {
        ctx.pos++;
        const map = parseInlineThenBlockMapping(ctx, contentCol, rest, line);
        return recordAnchor(ctx, anchor, map);
    }

    // Tagged item.
    if (tag != null) {
        // `- !tag {flow}` / `- !tag scalar` / `- !tag` (block body follows) /
        // `- !tag key: v` (tagged compact mapping)
        if (rest.trim() === '') {
            ctx.pos++;
            const next = ctx.lines[ctx.pos];
            let body;
            if (next && next.indent > dashIndent) body = parseNode(ctx, next.indent);
            else body = null;
            return recordAnchor(ctx, anchor, tagged(tag, body));
        }
        if (isMappingStart(rest)) {
            ctx.pos++;
            const map = parseInlineThenBlockMapping(ctx, contentCol, rest, line);
            return recordAnchor(ctx, anchor, tagged(tag, map));
        }
        ctx.pos++;
        return recordAnchor(ctx, anchor, tagged(tag, parseFlowOrScalar(rest, line, ctx)));
    }

    // Plain scalar / flow / alias item.
    ctx.pos++;
    return recordAnchor(ctx, anchor, parseFlowOrScalar(rest, line, ctx));
}

function parseBlockMapping(ctx, indent) {
    const map = {};
    while (ctx.pos < ctx.lines.length) {
        const line = ctx.lines[ctx.pos];
        if (line.indent < indent) break;
        if (line.indent > indent) {
            throw new AsdfError(`unexpected over-indent at line ${line.lineNo} (expected ${indent}, got ${line.indent}) in ${ctx.label}`);
        }
        if (line.text === '-' || line.text.startsWith('- ')) break; // seq at same indent → caller handles
        parseMappingEntry(ctx, indent, line, map);
    }
    return map;
}

/** Parse one `key: value` entry (value may be inline or a following block). */
function parseMappingEntry(ctx, indent, line, map) {
    const { key, rest } = splitKey(line.text, line, ctx.label);
    ctx.pos++;

    // value handling: inline (after the colon) vs block (indented next lines).
    let { anchor, tag, rest: vrest } = takeAnchorAndTag(rest.trim());

    if (vrest.trim() === '') {
        // block value on following lines (deeper indent) — mapping or sequence.
        const next = ctx.lines[ctx.pos];
        let value;
        if (next && next.indent > indent) {
            value = parseNode(ctx, next.indent);
        } else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
            // a block sequence whose dashes sit at the SAME indent as the key
            value = parseBlockSequence(ctx, indent);
        } else {
            value = null; // empty value
        }
        if (tag != null) value = tagged(tag, value);
        map[key] = recordAnchor(ctx, anchor, value);
        return;
    }

    // inline value after the colon.
    let value;
    if (tag != null) {
        // `key: !tag {flow}` / `key: !tag scalar` / `key: !tag` + block body.
        if (isFlowStart(vrest) || isScalarInline(vrest)) {
            value = tagged(tag, parseFlowOrScalar(vrest, line, ctx));
        } else {
            value = tagged(tag, parseFlowOrScalar(vrest, line, ctx));
        }
    } else {
        value = parseFlowOrScalar(vrest, line, ctx);
    }
    map[key] = recordAnchor(ctx, anchor, value);
}

/**
 * Used for compact mapping items (`- key: v` then aligned keys). Parses the first
 * entry from `firstLineRest`, then continues consuming aligned keys as a mapping.
 */
function parseInlineThenBlockMapping(ctx, col, firstLineRest, firstLine) {
    const map = {};
    // synthesise a line object for the first entry so parseMappingEntry can run.
    const synthetic = { indent: col, text: firstLineRest, lineNo: firstLine.lineNo };
    // parseMappingEntry advances ctx.pos, but we already advanced past firstLine.
    // Temporarily splice the synthetic line in front.
    ctx.lines.splice(ctx.pos, 0, synthetic);
    parseMappingEntry(ctx, col, synthetic, map);
    // continue with any further aligned keys
    while (ctx.pos < ctx.lines.length) {
        const l = ctx.lines[ctx.pos];
        if (l.indent !== col) break;
        if (l.text === '-' || l.text.startsWith('- ')) break;
        parseMappingEntry(ctx, col, l, map);
    }
    return map;
}

// ── scalar / flow parsing ───────────────────────────────────────────────────────

function parseFlowOrScalar(text, line, ctx) {
    const t = text.trim();
    if (t.startsWith('*')) return resolveAlias(ctx, t.slice(1).trim(), line);
    if (t.startsWith('[') || t.startsWith('{')) return parseFlow(t, line, ctx.label);
    return parseScalar(t, line, ctx.label);
}

/** Parse a flow collection `[...]` or `{...}` (recursive, quote-aware). */
function parseFlow(text, line, label) {
    const p = { s: text, i: 0, line, label };
    skipWs(p);
    const v = parseFlowValue(p);
    skipWs(p);
    if (p.i < p.s.length) {
        throw new AsdfError(`trailing characters after flow value at line ${line.lineNo}: ${JSON.stringify(p.s.slice(p.i))} in ${label}`);
    }
    return v;
}

function parseFlowValue(p) {
    skipWs(p);
    const c = p.s[p.i];
    if (c === '[') return parseFlowSeq(p);
    if (c === '{') return parseFlowMap(p);
    return parseFlowScalar(p);
}

function parseFlowSeq(p) {
    p.i++; // consume '['
    const arr = [];
    skipWs(p);
    if (p.s[p.i] === ']') { p.i++; return arr; }
    for (;;) {
        arr.push(parseFlowValue(p));
        skipWs(p);
        const c = p.s[p.i];
        if (c === ',') { p.i++; skipWs(p); if (p.s[p.i] === ']') { p.i++; return arr; } continue; }
        if (c === ']') { p.i++; return arr; }
        throw new AsdfError(`malformed flow sequence at line ${p.line.lineNo} near ${JSON.stringify(p.s.slice(p.i, p.i + 12))} in ${p.label}`);
    }
}

function parseFlowMap(p) {
    p.i++; // consume '{'
    const map = {};
    skipWs(p);
    if (p.s[p.i] === '}') { p.i++; return map; }
    for (;;) {
        skipWs(p);
        const key = parseFlowScalarRaw(p, /*asKey*/ true);
        skipWs(p);
        if (p.s[p.i] !== ':') {
            throw new AsdfError(`expected ':' in flow mapping at line ${p.line.lineNo} near ${JSON.stringify(p.s.slice(p.i, p.i + 12))} in ${p.label}`);
        }
        p.i++;
        const val = parseFlowValue(p);
        map[String(key)] = val;
        skipWs(p);
        const c = p.s[p.i];
        if (c === ',') { p.i++; skipWs(p); if (p.s[p.i] === '}') { p.i++; return map; } continue; }
        if (c === '}') { p.i++; return map; }
        throw new AsdfError(`malformed flow mapping at line ${p.line.lineNo} near ${JSON.stringify(p.s.slice(p.i, p.i + 12))} in ${p.label}`);
    }
}

function parseFlowScalar(p) { return parseFlowScalarRaw(p, false); }

/** Parse a single scalar token inside a flow context (stops at , ] } :). */
function parseFlowScalarRaw(p, asKey) {
    skipWs(p);
    const c = p.s[p.i];
    if (c === '"' || c === "'") return parseQuoted(p);
    let start = p.i;
    while (p.i < p.s.length && !',]}:'.includes(p.s[p.i])) p.i++;
    // for a key, a ':' terminates; for a value ':' inside is unusual — but our
    // writers never emit bare ':' inside plain flow scalars.
    const tokRaw = p.s.slice(start, p.i).trim();
    return interpretScalar(tokRaw, p.line, p.label);
}

function parseQuoted(p) {
    const q = p.s[p.i]; p.i++;
    let out = '';
    while (p.i < p.s.length) {
        const c = p.s[p.i];
        if (c === '\\' && q === '"') {
            const n = p.s[p.i + 1];
            out += unescapeChar(n, p);
            p.i += 2;
            continue;
        }
        if (c === q) {
            // single-quote doubled-escape ''
            if (q === "'" && p.s[p.i + 1] === "'") { out += "'"; p.i += 2; continue; }
            p.i++;
            return out;
        }
        out += c; p.i++;
    }
    throw new AsdfError(`unterminated quoted scalar at line ${p.line.lineNo} in ${p.label}`);
}

function unescapeChar(n, p) {
    switch (n) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        case 'b': return '\b';
        case 'f': return '\f';
        case '0': return '\0';
        case 'u': {
            const hex = p.s.slice(p.i + 2, p.i + 6);
            p.i += 4; // extra advance for the 4 hex digits (the +2 is done by caller)
            return String.fromCharCode(parseInt(hex, 16));
        }
        default:
            throw new AsdfError(`unsupported escape \\${n} at line ${p.line.lineNo} in ${p.label}`);
    }
}

function skipWs(p) { while (p.i < p.s.length && (p.s[p.i] === ' ' || p.s[p.i] === '\t')) p.i++; }

/** A block-context scalar (already isolated on its line, comment stripped). */
function parseScalar(text, line, label) {
    const t = text.trim();
    if (t.startsWith('"') || t.startsWith("'")) {
        const p = { s: t, i: 0, line, label };
        const v = parseQuoted(p);
        skipWs(p);
        if (p.i < p.s.length) {
            throw new AsdfError(`trailing characters after quoted scalar at line ${line.lineNo}: ${JSON.stringify(p.s.slice(p.i))} in ${label}`);
        }
        return v;
    }
    return interpretScalar(t, line, label);
}

/** Interpret an unquoted (plain) scalar token as null/bool/number/string. */
function interpretScalar(tok, line, label) {
    if (tok === '' ) return null;
    if (tok === '~' || tok === 'null' || tok === 'Null' || tok === 'NULL') return null;
    if (tok === 'true' || tok === 'True' || tok === 'TRUE') return true;
    if (tok === 'false' || tok === 'False' || tok === 'FALSE') return false;
    if (tok === '.inf' || tok === '.Inf' || tok === '+.inf') return Infinity;
    if (tok === '-.inf' || tok === '-.Inf') return -Infinity;
    if (tok === '.nan' || tok === '.NaN' || tok === '.NAN') return NaN;
    // integer
    if (/^[+-]?\d+$/.test(tok)) {
        const n = Number(tok);
        return Number.isSafeInteger(n) ? n : BigInt(tok);
    }
    // float / exponential (YAML 1.1 core float grammar, dot required for our writer)
    if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(tok) && /[.eE]/.test(tok)) {
        return Number(tok);
    }
    // a bare unquoted string (Roman meta values, unit tokens, enum-likes)
    return tok;
}

function isScalarInline(rest) {
    const t = rest.trim();
    return !(t.startsWith('[') || t.startsWith('{'));
}
function isFlowStart(rest) {
    const t = rest.trim();
    return t.startsWith('[') || t.startsWith('{');
}

// ── tag / anchor / key helpers ──────────────────────────────────────────────────

/** Split a `key: rest` head. Handles quoted keys. Returns {key, rest}. */
function splitKey(text, line, label) {
    if (text.startsWith('"') || text.startsWith("'")) {
        const p = { s: text, i: 0, line, label };
        const key = parseQuoted(p);
        skipWs(p);
        if (p.s[p.i] !== ':') throw new AsdfError(`expected ':' after quoted key at line ${line.lineNo} in ${label}`);
        return { key, rest: p.s.slice(p.i + 1) };
    }
    const idx = findColon(text);
    if (idx < 0) {
        throw new AsdfError(`expected 'key: value' mapping at line ${line.lineNo}, got ${JSON.stringify(text)} in ${label} (block scalars '|'/'>' and bare values are UNSUPPORTED here)`);
    }
    return { key: text.slice(0, idx).trim(), rest: text.slice(idx + 1) };
}

/** Index of the mapping colon: a ':' followed by space or end-of-line, not inside
 * a flow/quote. Sufficient for the block-key position (start of a line). */
function findColon(text) {
    let depth = 0, q = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
        else if (c === ':' && depth === 0 && (i + 1 >= text.length || text[i + 1] === ' ')) return i;
    }
    return -1;
}

function isMappingStart(rest) {
    const t = rest.trim();
    if (t.startsWith('[') || t.startsWith('{')) return false;
    return findColon(t) >= 0;
}

/** Peel a leading `&anchor` and/or `!tag` off a value fragment. Order per YAML
 * allows either; our writers emit `!tag` alone and `&id !tag` never — but asdf
 * emits `&id` on aliased nodes and `!tag &id` / `&id !tag` both occur. */
function takeAnchorAndTag(fragment) {
    let anchor = null, tag = null;
    let s = fragment.trim();
    for (let guard = 0; guard < 2; guard++) {
        if (s.startsWith('&')) {
            const m = /^&(\S+)\s*(.*)$/s.exec(s);
            anchor = m[1]; s = m[2];
            continue;
        }
        if (s.startsWith('!')) {
            const t = takeTag(s);
            tag = t.tag; s = t.rest;
            continue;
        }
        break;
    }
    return { anchor, tag, rest: s };
}

/** Take a leading tag token: verbose `!<...>` or short `!word/...`. */
function takeTag(s) {
    if (s.startsWith('!<')) {
        const end = s.indexOf('>');
        if (end < 0) throw new AsdfError(`unterminated verbose tag '${s.slice(0, 20)}…'`);
        return { tag: s.slice(0, end + 1), rest: s.slice(end + 1).trimStart() };
    }
    const m = /^(!\S*)\s*(.*)$/s.exec(s);
    return { tag: m[1], rest: m[2] };
}

function stripBang(s) { return s.startsWith('!') ? s.slice(1) : s; }
function stripComment(line) {
    // strip a `#` comment only when preceded by whitespace or at col 0 AND not
    // inside a quote. Our writers never put inline `#` after values, and the
    // `#ASDF` header lines are handled before YAML parsing — so a simple
    // quote-aware trailing-comment strip is safe.
    let q = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
            return line.slice(0, i).replace(/\s+$/, '');
        }
    }
    return line.replace(/\s+$/, '');
}

/**
 * Net unclosed flow-bracket depth of a line (quote-aware). > 0 ⇒ a `[`/`{` was
 * opened but not closed on this line, so the flow continues on the next line.
 * Only `[]{}` count; tag angle-brackets `!<…>` and bracket chars inside quotes
 * are ignored. A trailing `#` comment stops the scan.
 */
function flowDepth(s) {
    let depth = 0, q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === q) {
                if (q === "'" && s[i + 1] === "'") { i++; continue; } // '' escape
                if (q === '"' && s[i - 1] === '\\') continue;          // \" escape
                q = null;
            }
            continue;
        }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) break;
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
    }
    return depth;
}

function recordAnchor(ctx, anchor, value) {
    if (anchor) ctx.anchors.set(anchor, value);
    return value;
}
function resolveAlias(ctx, name, line) {
    if (!ctx.anchors.has(name)) {
        throw new AsdfError(`alias *${name} references an unknown anchor at line ${line.lineNo} in ${ctx.label}`);
    }
    return ctx.anchors.get(name);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BINARY BLOCK PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function findFirstBlock(buf) {
    return buf.indexOf(BLOCK_MAGIC);
}

/**
 * Walk the binary blocks sequentially from `start`, reading each 48-byte header.
 * Deterministic (no magic scanning inside data): each block's size fields give
 * the next block's offset. Stops at the block index marker or EOF.
 */
function walkBlocks(buf, start, label) {
    const blocks = [];
    let off = start;
    let index = 0;
    while (off + 6 <= buf.length) {
        // stop if we've reached the block index document rather than a block
        if (buf.toString('latin1', off, off + 4) !== '\xd3BLK') {
            // could be the `#ASDF BLOCK INDEX` trailer or padding
            break;
        }
        const headerSize = buf.readUInt16BE(off + 4);
        const hdrStart = off + 6;
        if (headerSize < 48 || hdrStart + headerSize > buf.length) {
            throw new AsdfError(`block ${index}: bad header_size ${headerSize} at offset ${off} in ${label}`);
        }
        const flags = buf.readUInt32BE(hdrStart);
        const compRaw = buf.subarray(hdrStart + 4, hdrStart + 8);
        const compression = compRaw.every(b => b === 0) ? 'none' : compRaw.toString('latin1').replace(/\0+$/, '');
        const allocatedSize = readU64(buf, hdrStart + 8);
        const usedSize = readU64(buf, hdrStart + 16);
        const dataSize = readU64(buf, hdrStart + 24);
        const dataStart = hdrStart + headerSize;
        blocks.push({ index, offset: off, dataStart, allocatedSize, usedSize, dataSize, compression, flags });
        // advance to the next block: data region reserves `allocatedSize` bytes.
        const advance = allocatedSize >= usedSize ? allocatedSize : usedSize;
        off = dataStart + advance;
        index++;
        if (index > 100000) throw new AsdfError(`block walk exceeded 100000 blocks in ${label} (corrupt file?)`);
    }
    return blocks;
}

/** Read a uint64 big-endian as a JS number (safe: ASDF arrays are < 2^53 bytes). */
function readU64(buf, off) {
    const hi = buf.readUInt32BE(off);
    const lo = buf.readUInt32BE(off + 4);
    return hi * 0x100000000 + lo;
}

// ── ndarray resolution (tree ndarray node → typed data) ─────────────────────────

const DTYPE_MAP = {
    uint8: { get: 'readUInt8', size: 1 }, int8: { get: 'readInt8', size: 1 },
    uint16: { get: 'readUInt16', size: 2 }, int16: { get: 'readInt16', size: 2 },
    uint32: { get: 'readUInt32', size: 4 }, int32: { get: 'readInt32', size: 4 },
    float32: { get: 'readFloat', size: 4 }, float64: { get: 'readDouble', size: 8 },
    int64: { get: 'readBigInt64', size: 8 }, uint64: { get: 'readBigUInt64', size: 8 },
};

/**
 * Resolve a `!core/ndarray` tree node to { shape, dtype, data:Buffer, byteorder,
 * source }. When `source` is an integer it references a binary block; when it is
 * an inline array (gwcs matrices) the data is returned as-is under `inline`.
 */
function resolveNdarray(node, readBlock, label) {
    const body = untag(node);
    if (!body || typeof body !== 'object') {
        throw new AsdfError(`expected an ndarray node, got ${JSON.stringify(body)} in ${label}`);
    }
    const shape = (body.shape || []).map(Number);
    const dtype = normaliseDtype(body.datatype);
    const byteorder = body.byteorder || 'little';
    const source = body.source;

    if (Array.isArray(body.data)) {
        return { shape, dtype, byteorder, inline: body.data, source: null };
    }
    if (typeof source !== 'number') {
        throw new AsdfError(`ndarray has no integer 'source' and no inline 'data' in ${label} (source=${JSON.stringify(source)})`);
    }
    const raw = readBlock(source);
    return { shape, dtype, byteorder, source, data: raw };
}

function normaliseDtype(dt) {
    if (typeof dt === 'string') return dt;
    // asdf can express datatype as ['uint16'] or a struct; we support the scalar form.
    if (Array.isArray(dt) && dt.length === 1 && typeof dt[0] === 'string') return dt[0];
    throw new AsdfError(`unsupported ndarray datatype ${JSON.stringify(dt)} (only scalar dtypes are supported)`);
}

/** Decode a resolved block ndarray into a JS typed array (little-endian). */
export function decodeNdarray(resolved, label = '<ndarray>') {
    if (resolved.inline) return resolved.inline; // already native JS numbers
    const { dtype, data, byteorder } = resolved;
    const spec = DTYPE_MAP[dtype];
    if (!spec) throw new AsdfError(`cannot decode dtype '${dtype}' in ${label}`);
    const le = byteorder !== 'big';
    const count = Math.floor(data.length / spec.size);
    const out = new Array(count);
    const suffix = spec.size === 1 ? '' : (le ? 'LE' : 'BE');
    const method = spec.get + suffix;
    for (let i = 0; i < count; i++) out[i] = data[method](i * spec.size);
    return out;
}

// ── error type ──────────────────────────────────────────────────────────────────

export class AsdfError extends Error {
    constructor(msg) { super(msg); this.name = 'AsdfError'; }
}

// ── thin CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
    const file = process.argv[2];
    const mode = process.argv[3] || '--tree';
    if (!file) {
        console.error('usage: node tools/asdf/asdf_reader.mjs <file.asdf> [--tree|--blocks|--json]');
        process.exit(2);
    }
    const asdf = readAsdfFile(file);
    if (mode === '--blocks') {
        console.log(JSON.stringify(asdf.blocks, null, 2));
    } else if (mode === '--json') {
        console.log(JSON.stringify(asdf.tree, tagReplacer, 2));
    } else {
        console.log('comments:', asdf.comments);
        console.log('standardVersion:', asdf.standardVersion);
        console.log('blocks:', asdf.blocks.length);
        console.log('tree keys:', Object.keys(asdf.tree));
    }
}

/** JSON.stringify replacer that surfaces tagged nodes as {"!tag": value}. */
export function tagReplacer(_key, value) {
    if (isTagged(value)) return { ['!' + stripBang(value.__tag__)]: value.__value__ };
    if (typeof value === 'bigint') return value.toString();
    return value;
}
