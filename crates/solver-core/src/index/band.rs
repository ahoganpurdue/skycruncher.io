//! Per-band key lookup: a 2^16-bucket prefix table over `code_key >> 12` (256 KiB/band)
//! narrows every probe to one bucket window; a lower-bound binary search + forward duplicate
//! scan over the mmapped sorted key column finishes the job. Global rows throughout
//! (row r ⇒ batch r/batchRows, offset r%batchRows) — immune to the manifest's overlapping
//! per-batch key ranges.
//!
//! Prefix tables are built EXPLICITLY in the prepare phase (`QuadIndex::build_prefix_tables`)
//! so the solve loop never allocates.

use arrow_buffer::ScalarBuffer;

use super::manifest::BandBlob;
use super::mmap_arrow::{BandView, QuadRow};

/// Bucket = (code_key as u32) >> PREFIX_SHIFT.
pub const PREFIX_SHIFT: u32 = 12;
/// 2^16 buckets (+1 sentinel slot).
pub const PREFIX_BUCKETS: usize = 1 << 16;
/// Key space: nbins^4 = 128^4 = 2^28 (manifest-validated nbins == 128).
pub const KEY_SPACE: u32 = 1 << 28;

/// One scale band: manifest metadata + mmapped columns + optional prefix table.
pub struct Band {
    pub index: u32,
    pub lo_deg: f64,
    pub hi_deg: f64,
    pub mag_limit: f64,
    pub n_quads: u64,
    pub view: BandView,
    prefix: Option<Box<[u32; PREFIX_BUCKETS + 1]>>,
}

impl Band {
    pub(crate) fn new(blob: &BandBlob, view: BandView) -> Self {
        Self {
            index: blob.index,
            lo_deg: blob.lo_deg,
            hi_deg: blob.hi_deg,
            mag_limit: blob.mag_limit,
            n_quads: blob.n_quads,
            view,
            prefix: None,
        }
    }

    /// Build the prefix table: `prefix[b]` = first global row whose key >= b << PREFIX_SHIFT;
    /// `prefix[PREFIX_BUCKETS]` = nRows. Single linear pass over the (already sort-validated)
    /// key column. Idempotent.
    pub fn build_prefix_table(&mut self) {
        if self.prefix.is_some() {
            return;
        }
        let n = self.view.n_rows;
        assert!(n <= u32::MAX as u64, "band {} rows {} exceed u32 prefix range", self.index, n);
        let mut table = vec![0u32; PREFIX_BUCKETS + 1];
        let mut next_bucket: usize = 0;
        let mut row: u32 = 0;
        for batch in &self.view.batches {
            let keys: &[i32] = batch.key.as_ref();
            for &k in keys {
                // keys validated non-negative + sorted at open
                let b = ((k as u32) >> PREFIX_SHIFT) as usize;
                while next_bucket <= b {
                    table[next_bucket] = row;
                    next_bucket += 1;
                }
                row += 1;
            }
        }
        while next_bucket <= PREFIX_BUCKETS {
            table[next_bucket] = n as u32;
            next_bucket += 1;
        }
        let boxed: Box<[u32]> = table.into_boxed_slice();
        let boxed: Box<[u32; PREFIX_BUCKETS + 1]> =
            boxed.try_into().expect("prefix table length");
        self.prefix = Some(boxed);
    }

    #[inline]
    pub fn prefix_built(&self) -> bool {
        self.prefix.is_some()
    }

    /// Exact-key lookup: (first global row of the duplicate run, run length).
    /// For an absent key the row is the insertion point and the count is 0.
    /// Requires the prefix table (prepare-phase contract violation otherwise).
    #[inline]
    pub fn lookup(&self, key: i32) -> (u64, u32) {
        let prefix = self
            .prefix
            .as_ref()
            .expect("band prefix table not built — call QuadIndex::build_prefix_tables in prepare");
        let n = self.view.n_rows;
        if n == 0 || key < 0 {
            return (0, 0);
        }
        let k = key as u32;
        if k >= KEY_SPACE {
            return (n, 0);
        }
        let b = (k >> PREFIX_SHIFT) as usize;
        let bucket_start = prefix[b] as u64;
        let bucket_end = prefix[b + 1] as u64;
        // lower bound within the bucket window
        let mut lo = bucket_start;
        let mut hi = bucket_end;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if self.view.key_at(mid) < key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        // forward scan the duplicate run (equal keys share a bucket, so it ends by bucket_end)
        let mut end = lo;
        while end < bucket_end && self.view.key_at(end) == key {
            end += 1;
        }
        (lo, (end - lo) as u32)
    }

    /// Iterate quad rows over a global-row range, transparently crossing batch boundaries.
    #[inline]
    pub fn rows(&self, start: u64, count: u32) -> RowRange<'_> {
        let end = start + count as u64;
        assert!(end <= self.view.n_rows, "row range {start}+{count} exceeds band rows {}", self.view.n_rows);
        RowRange {
            view: &self.view,
            cur: start,
            end,
        }
    }

    #[inline]
    pub fn row(&self, r: u64) -> QuadRow {
        self.view.quad_at(r)
    }

    /// Direct key-column view of a batch (differential/brute test paths).
    #[inline]
    pub fn batch_keys(&self, batch: usize) -> &ScalarBuffer<i32> {
        &self.view.batches[batch].key
    }
}

/// Iterator over a contiguous global-row range of a band.
pub struct RowRange<'a> {
    view: &'a BandView,
    cur: u64,
    end: u64,
}

impl<'a> Iterator for RowRange<'a> {
    type Item = QuadRow;

    #[inline]
    fn next(&mut self) -> Option<QuadRow> {
        if self.cur >= self.end {
            return None;
        }
        let q = self.view.quad_at(self.cur);
        self.cur += 1;
        Some(q)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = (self.end - self.cur) as usize;
        (n, Some(n))
    }
}

impl<'a> ExactSizeIterator for RowRange<'a> {}
