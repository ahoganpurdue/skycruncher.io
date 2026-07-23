import { describe, it, expect } from 'vitest';
import {
    formatBytes,
    progressPercent,
    statusFileLabel,
    resultFileLabel,
    parseStarDataStatus,
    parseStarDataReport,
    parseProgressEvent,
    summarizeStatus,
    statusAllPresent,
    shouldShowStarDataBanner,
    reportIsComplete,
    summarizeReport,
    progressCaption,
    fetchStarDataStatus,
    starDataArgs,
    type StarDataStatus,
    type StarDataReport,
    type InvokeFn,
} from './starDataView';

const goodStatus = (over: Partial<StarDataStatus> = {}): StarDataStatus => ({
    index_root: 'D:/AstroLogic/index',
    manifest_source: 'local',
    release: 'starplates-2026.07-quadidx-g15u',
    file_count: 16,
    total_bytes: 1020924800,
    present_count: 3,
    present_bytes: 200000000,
    files: [
        { file: 'stars.arrow', bytes: 181771274, state: 'present' },
        { file: 'band_0.arrow', bytes: 503430346, state: 'missing' },
        { file: 'band_1.arrow', bytes: 100, state: 'size_mismatch' },
    ],
    ...over,
});

const goodReport = (over: Partial<StarDataReport> = {}): StarDataReport => ({
    phase: 'download',
    index_root: 'D:/AstroLogic/index',
    manifest_source: 'local',
    release: 'starplates-2026.07-quadidx-g15u',
    file_count: 16,
    total_bytes: 1020924800,
    verified_count: 16,
    downloaded_count: 16,
    bytes_fetched: 1020924800,
    cancelled: false,
    complete: true,
    files: [{ file: 'stars.arrow', bytes: 181771274, state: 'verified', fetched_bytes: 181771274, reason: null }],
    ...over,
});

describe('formatBytes', () => {
    it('uses base-1024 with GB/MB/KB/B labels (matches fetch_index.mjs fmtBytes)', () => {
        expect(formatBytes(1610612736)).toBe('1.50 GB'); // 1.5 GiB
        expect(formatBytes(1020924800)).toBe('973.6 MB'); // 0.95 GiB stays MB (under 1 GiB), like the CLI
        expect(formatBytes(181771274)).toBe('173.4 MB');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(500)).toBe('500 B');
    });
    it('is honest about invalid input', () => {
        expect(formatBytes(-1)).toBe('—');
        expect(formatBytes(NaN)).toBe('—');
    });
});

describe('progressPercent', () => {
    it('clamps to 0–100 and returns 0 for zero total', () => {
        expect(progressPercent(50, 100)).toBe(50);
        expect(progressPercent(0, 0)).toBe(0);
        expect(progressPercent(150, 100)).toBe(100);
        expect(progressPercent(-5, 100)).toBe(0);
    });
});

describe('honest file labels', () => {
    it('never calls present-by-size "verified"', () => {
        expect(statusFileLabel('present')).toBe('present (not verified)');
        expect(statusFileLabel('size_mismatch')).toBe('SIZE MISMATCH');
        expect(statusFileLabel('missing')).toBe('MISSING');
    });
    it('labels sha-checked results', () => {
        expect(resultFileLabel('verified')).toBe('verified');
        expect(resultFileLabel('mismatch')).toBe('SHA MISMATCH');
        expect(resultFileLabel('error')).toBe('ERROR');
    });
});

describe('parseStarDataStatus', () => {
    it('accepts a well-formed payload', () => {
        expect(parseStarDataStatus(goodStatus())).not.toBeNull();
    });
    it('rejects malformed payloads (absent beats fake)', () => {
        expect(parseStarDataStatus(null)).toBeNull();
        expect(parseStarDataStatus({})).toBeNull();
        expect(parseStarDataStatus({ ...goodStatus(), file_count: 'x' })).toBeNull();
        expect(parseStarDataStatus({ ...goodStatus(), files: [{ file: 'a' }] })).toBeNull();
        expect(parseStarDataStatus({ ...goodStatus(), manifest_source: 5 })).toBeNull();
    });
    it('allows null manifest_source/release', () => {
        expect(parseStarDataStatus(goodStatus({ manifest_source: null, release: null }))).not.toBeNull();
    });
});

describe('parseStarDataReport', () => {
    it('accepts a well-formed report and rejects malformed ones', () => {
        expect(parseStarDataReport(goodReport())).not.toBeNull();
        expect(parseStarDataReport({ ...goodReport(), complete: 'yes' })).toBeNull();
        expect(parseStarDataReport({ ...goodReport(), files: [{ file: 'a', bytes: 1 }] })).toBeNull();
    });
});

describe('parseProgressEvent', () => {
    const p = {
        phase: 'download',
        file: 'band_0.arrow',
        file_index: 2,
        file_count: 16,
        file_done_bytes: 100,
        file_total_bytes: 503430346,
        overall_done_bytes: 181771374,
        overall_total_bytes: 1020924800,
    };
    it('unwraps a Tauri event { payload } and accepts a bare payload', () => {
        expect(parseProgressEvent({ event: 'star-data-progress', payload: p })).toEqual(p);
        expect(parseProgressEvent(p)).toEqual(p);
    });
    it('rejects garbage', () => {
        expect(parseProgressEvent({ payload: { phase: 'x' } })).toBeNull();
        expect(parseProgressEvent(42)).toBeNull();
    });
});

describe('honest summaries', () => {
    it('summarizeStatus never claims verification from a size check', () => {
        const s = summarizeStatus(goodStatus());
        expect(s).toContain('present by size');
        expect(s).toContain('not yet sha-verified');
    });
    it('summarizeStatus is honest when no manifest is available', () => {
        const s = summarizeStatus(goodStatus({ file_count: 0, files: [], manifest_source: null }));
        expect(s).toContain('not provisioned');
    });
    it('statusAllPresent only when present === file_count', () => {
        expect(statusAllPresent(goodStatus({ present_count: 16, file_count: 16 }))).toBe(true);
        expect(statusAllPresent(goodStatus({ present_count: 3, file_count: 16 }))).toBe(false);
    });
});

describe('shouldShowStarDataBanner', () => {
    it('hidden when every manifest file is present by size', () => {
        expect(shouldShowStarDataBanner(goodStatus({ present_count: 16, file_count: 16 }))).toBe(false);
    });
    it('shown when partially present (solve capability limited)', () => {
        expect(shouldShowStarDataBanner(goodStatus({ present_count: 3, file_count: 16 }))).toBe(true);
    });
    it('shown when unprovisioned / offline (file_count 0, no manifest)', () => {
        expect(
            shouldShowStarDataBanner(
                goodStatus({ file_count: 0, present_count: 0, files: [], manifest_source: null }),
            ),
        ).toBe(true);
    });
});

describe('reportIsComplete — "done" is earned only by full sha verification', () => {
    it('true only when complete flag AND verified_count === file_count', () => {
        expect(reportIsComplete(goodReport())).toBe(true);
        // complete flag lies but counts disagree → still not done
        expect(reportIsComplete(goodReport({ verified_count: 15 }))).toBe(false);
        // counts agree but engine did not mark complete → not done
        expect(reportIsComplete(goodReport({ complete: false }))).toBe(false);
        // no files → not done
        expect(reportIsComplete(goodReport({ file_count: 0, verified_count: 0, complete: true }))).toBe(false);
    });
    it('summarizeReport voices done/cancelled/incomplete honestly', () => {
        expect(summarizeReport(goodReport())).toContain('DONE');
        expect(summarizeReport(goodReport({ cancelled: true, complete: false, verified_count: 4 }))).toContain('CANCELLED');
        expect(summarizeReport(goodReport({ complete: false, verified_count: 15, files: [
            { file: 'band_0.arrow', bytes: 1, state: 'error', fetched_bytes: 0, reason: 'HTTP 500' },
        ] }))).toContain('INCOMPLETE');
    });
});

describe('progressCaption', () => {
    it('uses the phase verb and overall bytes', () => {
        const cap = progressCaption({
            phase: 'reassemble', file: 'band_0.arrow', file_index: 2, file_count: 16,
            file_done_bytes: 1, file_total_bytes: 2, overall_done_bytes: 3, overall_total_bytes: 4,
        });
        expect(cap).toContain('Reassembling');
        expect(cap).toContain('band_0.arrow');
        expect(cap).toContain('2/16');
    });
});

describe('fetchStarDataStatus (injected invoke)', () => {
    it('passes baseUrl + prefix and returns parsed status', async () => {
        let seenCmd = '';
        let seenArgs: Record<string, unknown> | undefined;
        const inv: InvokeFn = async (cmd, args) => {
            seenCmd = cmd;
            seenArgs = args;
            return goodStatus();
        };
        const out = await fetchStarDataStatus('https://base', 'pref', inv);
        expect(seenCmd).toBe('star_data_status');
        expect(seenArgs).toEqual({ baseUrl: 'https://base', prefix: 'pref' });
        expect(out.kind).toBe('status');
    });
    it('resolves error (never rejects) when invoke throws', async () => {
        const inv: InvokeFn = async () => {
            throw new Error('command not found');
        };
        const out = await fetchStarDataStatus('https://base', 'pref', inv);
        expect(out).toEqual({ kind: 'error', reason: 'command not found' });
    });
    it('resolves error on a malformed payload', async () => {
        const inv: InvokeFn = async () => ({ garbage: true });
        const out = await fetchStarDataStatus('https://base', 'pref', inv);
        expect(out.kind).toBe('error');
    });
    it('adds kind:"atlas" to the args for the atlas release', async () => {
        let seenArgs: Record<string, unknown> | undefined;
        const inv: InvokeFn = async (_cmd, args) => {
            seenArgs = args;
            return goodStatus();
        };
        const out = await fetchStarDataStatus('https://base', 'atlas-pref', inv, 'atlas');
        expect(seenArgs).toEqual({ baseUrl: 'https://base', prefix: 'atlas-pref', kind: 'atlas' });
        expect(out.kind).toBe('status');
    });
    it('omits kind for the index release (byte-identical to the pre-atlas call)', async () => {
        let seenArgs: Record<string, unknown> | undefined;
        const inv: InvokeFn = async (_cmd, args) => {
            seenArgs = args;
            return goodStatus();
        };
        await fetchStarDataStatus('https://base', 'pref', inv, 'index');
        expect(seenArgs).toEqual({ baseUrl: 'https://base', prefix: 'pref' });
        expect('kind' in (seenArgs ?? {})).toBe(false);
    });
});

describe('starDataArgs', () => {
    it('omits kind for index (default) and includes it for atlas', () => {
        expect(starDataArgs('b', 'p')).toEqual({ baseUrl: 'b', prefix: 'p' });
        expect(starDataArgs('b', 'p', 'index')).toEqual({ baseUrl: 'b', prefix: 'p' });
        expect(starDataArgs('b', 'p', 'atlas')).toEqual({ baseUrl: 'b', prefix: 'p', kind: 'atlas' });
    });
});
