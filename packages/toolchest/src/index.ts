/**
 * @skycruncher/toolchest — Arrow Carrier program, Phase 1: the forcing consumer.
 *
 * Turns a completed run's receipt (from `tools/api/headless_driver.ts`
 * runWizardPipeline) into Apache Arrow tables for the TABULAR products. Tables
 * ride Arrow; rasters ride typed arrays (never mixed). Non-nullable vectors
 * wherever the receipt guarantees presence — no validity-bitmap tax. Every table
 * carries schema + field metadata citing the LAW-7 boundary
 * (binary_layouts#toolchest_arrow_export) and the receipt schema version, with
 * explicit UNITS per field (RA-hours vs RA-degrees labelled).
 */
export {
    matchedStarsTable,
    detectionsTable,
    forcedConfirmedTable,
    runSummaryTable,
    exportAllTables,
} from './tables';

export {
    tableToArrowFileBytes,
    arrowBytesToTable,
    writeArrowFile,
    readArrowFile,
} from './ipc';

export { LAW7_BOUNDARY, TOOLCHEST_ARROW_VERSION, PRODUCER } from './provenance';

export type {
    ReceiptLike,
    SolutionLike,
    MatchedStarLike,
    DetectionLike,
    ForcedConfirmedLike,
    ConfirmStatusLike,
    DeepConfirmedLike,
    SignalLike,
} from './receipt_types';
