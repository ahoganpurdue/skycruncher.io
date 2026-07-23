import { describe, it, expect } from 'vitest';
import { resolveIntakeConfig, DEFAULT_INTAKE_CONFIG } from '../ui/config/intake_config';

/**
 * INTAKE HANDOFF CONFIG (LAW 6 brand-neutral · LAW 3 honest-or-absent).
 * The default is a NULL upload URL — the card renders the handoff text WITHOUT
 * a dead link until the owner's shared-folder setup lands and the env is set.
 */
describe('resolveIntakeConfig', () => {
    it('defaults to a null upload URL (honest-or-absent: no dead link)', () => {
        const cfg = resolveIntakeConfig({});
        expect(cfg.uploadUrl).toBeNull();
        expect(cfg.uploadLabel).toBe(DEFAULT_INTAKE_CONFIG.uploadLabel);
        // undefined env is also honest-default (no throw)
        expect(resolveIntakeConfig().uploadUrl).toBeNull();
    });

    it('reads a configured URL + label from the Vite env bag (LAW 6 — config, not a literal)', () => {
        const cfg = resolveIntakeConfig({
            VITE_INTAKE_UPLOAD_URL: 'https://example.org/drop',
            VITE_INTAKE_UPLOAD_LABEL: 'community Drive folder',
        });
        expect(cfg.uploadUrl).toBe('https://example.org/drop');
        expect(cfg.uploadLabel).toBe('community Drive folder');
    });

    it('treats a blank/whitespace URL as absent (no dead link from an empty env var)', () => {
        expect(resolveIntakeConfig({ VITE_INTAKE_UPLOAD_URL: '   ' }).uploadUrl).toBeNull();
        expect(resolveIntakeConfig({ VITE_INTAKE_UPLOAD_URL: '' }).uploadUrl).toBeNull();
        // a blank label falls back to the neutral default, never empty
        expect(resolveIntakeConfig({ VITE_INTAKE_UPLOAD_LABEL: '  ' }).uploadLabel)
            .toBe(DEFAULT_INTAKE_CONFIG.uploadLabel);
    });
});
