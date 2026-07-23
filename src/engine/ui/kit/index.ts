/**
 * UI KIT — thin token-bound primitives hoisted from the per-file inline
 * versions (UI_STYLE_GUIDE.md B.5 blueprint; closes design-debt C3).
 *
 * Every component's class strings are copied VERBATIM from its source
 * implementation (PipelineWizard.tsx STYLES/badges, FindingsFeed.tsx
 * Chip/KV/empty state, PipelineInspector.tsx Section/DOT,
 * ForensicCalibrationStep.tsx CoefValue/cards) so migrating those files
 * onto the kit is a visual no-op. All colors bind @theme tokens in
 * src/index.css — no raw hex lives here.
 *
 * Tailwind NOTE: this directory is listed in the @source block of
 * src/index.css; classes used here compile because of that line.
 */

export { Chip, Badge } from './Chip';
export type { ChipTone } from './Chip';
export { KV, Readout } from './KV';
export { Section } from './Section';
export { Card, Panel } from './Panel';
export { StatusDot } from './StatusDot';
export type { StatusDotState } from './StatusDot';
export { HonestyBadge } from './HonestyBadge';
export type { HonestySource } from './HonestyBadge';
export { EmptyState } from './EmptyState';
export { CoefValue } from './CoefValue';
