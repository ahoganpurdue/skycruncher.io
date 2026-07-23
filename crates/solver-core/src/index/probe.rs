//! Probe blocks: (key, slot) pairs accumulated per det-quad block, sorted (`sort_unstable`,
//! near-sorted input in practice), then swept against one band's sorted key column — a
//! monotone merge-join that turns random probing into near-sequential access on the mmapped
//! column. Consecutive duplicate keys reuse the previous lookup result.
//!
//! `slot` is an opaque caller token (det-quad arena index in M4a); this module never
//! interprets it.

use super::band::Band;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub key: i32,
    pub slot: u32,
}

/// A reusable, caller-owned probe accumulator (construct once, `clear` per block).
pub struct ProbeBlock {
    entries: Vec<Probe>,
    sorted: bool,
}

impl ProbeBlock {
    pub fn with_capacity(cap: usize) -> Self {
        Self {
            entries: Vec::with_capacity(cap),
            sorted: false,
        }
    }

    #[inline]
    pub fn clear(&mut self) {
        self.entries.clear();
        self.sorted = false;
    }

    #[inline]
    pub fn push(&mut self, key: i32, slot: u32) {
        self.entries.push(Probe { key, slot });
        self.sorted = false;
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Sort by (key, slot). Near-sorted inputs make `sort_unstable` cheap.
    pub fn sort(&mut self) {
        self.entries.sort_unstable_by_key(|p| (p.key, p.slot));
        self.sorted = true;
    }

    #[inline]
    pub fn entries(&self) -> &[Probe] {
        &self.entries
    }

    /// Sweep the sorted probes against a band: calls `f(slot, row_start, row_count)` for every
    /// probe (count 0 = miss; caller filters). Requires `sort()` first — loud panic otherwise.
    pub fn sweep<F: FnMut(u32, u64, u32)>(&self, band: &Band, mut f: F) {
        assert!(self.sorted || self.entries.len() <= 1, "ProbeBlock::sweep before sort()");
        let mut last: Option<(i32, u64, u32)> = None;
        for p in &self.entries {
            let (row_start, row_count) = match last {
                Some((k, rs, rc)) if k == p.key => (rs, rc),
                _ => band.lookup(p.key),
            };
            last = Some((p.key, row_start, row_count));
            f(p.slot, row_start, row_count);
        }
    }
}
