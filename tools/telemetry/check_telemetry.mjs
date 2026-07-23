// Telemetry health check: is the collector listening, and is data landing?
//   node tools/telemetry/check_telemetry.mjs
// Verdicts are honest-or-absent: LISTENING/NOT LISTENING, FLOWING/STALE/ABSENT.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const metricsPath = path.join(root, 'test_results', 'otel', 'metrics.jsonl');
const logsPath = path.join(root, 'test_results', 'otel', 'logs.jsonl');

let listening = false;
try {
    // Any HTTP response (even 4xx for an empty body) proves a listener exists.
    const res = await fetch('http://127.0.0.1:4318/v1/metrics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(3000),
    });
    listening = true;
    console.log(`collector: LISTENING on 127.0.0.1:4318 (HTTP ${res.status})`);
} catch {
    console.log('collector: NOT LISTENING on 127.0.0.1:4318 — run tools/telemetry/start_collector.cmd');
}

for (const [label, p] of [['metrics.jsonl', metricsPath], ['logs.jsonl', logsPath]]) {
    if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        const ageMin = (Date.now() - st.mtimeMs) / 60000;
        console.log(`${label}: ${(st.size / 1024).toFixed(1)} KB, last write ${ageMin.toFixed(1)} min ago`);
    } else {
        console.log(`${label}: ABSENT`);
    }
}

if (!listening) {
    console.log('verdict: NOT FLOWING — start the collector, then restart Claude Code (env applies at startup).');
} else if (fs.existsSync(metricsPath) && (Date.now() - fs.statSync(metricsPath).mtimeMs) < 10 * 60000) {
    console.log('verdict: FLOWING');
} else {
    console.log('verdict: collector up, no recent data — restart Claude Code so OTEL env takes effect, use it a bit, re-check.');
}
