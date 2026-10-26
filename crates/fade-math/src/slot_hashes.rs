//! Bounded parser of the `SlotHashes` sysvar: `u64` count, then entries of
//! `(u64 slot, [u8; 32] hash)`, newest first, at most 512 of them.

/// Entries the sysvar retains.
pub const MAX_ENTRIES: usize = 512;
const ENTRY_LEN: usize = 40;

/// One entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    /// Slot number.
    pub slot: u64,
    /// The slot's bank hash.
    pub hash: [u8; 32],
}

/// Number of entries, if the buffer is well-formed.
pub fn len(data: &[u8]) -> Option<usize> {
    let count = u64::from_le_bytes(data.get(..8)?.try_into().ok()?);
    let count = usize::try_from(count).ok()?;
    if count > MAX_ENTRIES || data.len() < count.checked_mul(ENTRY_LEN)?.checked_add(8)? {
        return None;
    }
    Some(count)
}

/// The entry at index `i` (0 = newest).
pub fn entry(data: &[u8], i: usize) -> Option<Entry> {
    let start = i.checked_mul(ENTRY_LEN)?.checked_add(8)?;
    let slot = u64::from_le_bytes(data.get(start..start.checked_add(8)?)?.try_into().ok()?);
    let hash: [u8; 32] = data
        .get(start.checked_add(8)?..start.checked_add(40)?)?
        .try_into()
        .ok()?;
    Some(Entry { slot, hash })
}

/// The newest entry.
pub fn latest(data: &[u8]) -> Option<Entry> {
    if len(data)? == 0 {
        return None;
    }
    entry(data, 0)
}

/// The oldest entry whose slot is strictly greater than `t` — the first slot
/// produced after `t` that is still retained. Entries are newest first (the
/// runtime writes them that way; this parser relies on it and only checks the
/// boundary it lands on), so this is the last entry with `slot > t`. Returns
/// `None` if no entry is newer than `t`.
pub fn first_after(data: &[u8], t: u64) -> Option<Entry> {
    let n = len(data)?;
    if n == 0 || entry(data, 0)?.slot <= t {
        return None;
    }
    // binary search for the boundary: entries [0, hi) have slot > t
    let (mut lo, mut hi) = (0usize, n);
    while lo.checked_add(1)? < hi {
        let mid = lo.checked_add(hi.checked_sub(lo)?.checked_div(2)?)?;
        if entry(data, mid)?.slot > t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let found = entry(data, lo)?;
    (found.slot > t).then_some(found)
}

/// `first_after(t)`, but only when the sysvar still proves it is the first
/// slot produced after `t`: either an entry at or before `t` is retained, or
/// the entry found is `t + 1` itself. Once every entry up to `t` has left the
/// sysvar, an older slot after `t` may have been evicted rather than skipped,
/// and the oldest one retained would be the wrong slot: `None`.
pub fn first_after_retained(data: &[u8], t: u64) -> Option<Entry> {
    let found = first_after(data, t)?;
    let oldest = entry(data, len(data)?.checked_sub(1)?)?;
    (oldest.slot <= t || Some(found.slot) == t.checked_add(1)).then_some(found)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn build(slots: &[u64]) -> alloc::vec::Vec<u8> {
        let mut d = alloc::vec::Vec::with_capacity(8 + slots.len() * ENTRY_LEN);
        d.extend_from_slice(&(slots.len() as u64).to_le_bytes());
        for s in slots {
            d.extend_from_slice(&s.to_le_bytes());
            d.extend_from_slice(&[(*s % 251) as u8; 32]);
        }
        d
    }
    extern crate alloc;

    #[test]
    fn first_after_with_gaps() {
        let d = build(&[110, 109, 107, 106, 100]); // 108 skipped
        assert_eq!(first_after(&d, 99).unwrap().slot, 100);
        assert_eq!(first_after(&d, 100).unwrap().slot, 106);
        assert_eq!(first_after(&d, 107).unwrap().slot, 109);
        assert_eq!(first_after(&d, 109).unwrap().slot, 110);
        assert_eq!(first_after(&d, 110), None);
        assert_eq!(first_after(&d, 200), None);
        assert_eq!(latest(&d).unwrap().slot, 110);
    }

    #[test]
    fn first_after_retained_needs_the_boundary() {
        let d = build(&[110, 109, 107, 106, 100]);
        // The boundary retained: as `first_after`.
        assert_eq!(first_after_retained(&d, 100).unwrap().slot, 106);
        assert_eq!(first_after_retained(&d, 107).unwrap().slot, 109);
        assert_eq!(first_after_retained(&d, 110), None);
        // Nothing at or before 99 retained, but 100 is 99 + 1.
        assert_eq!(first_after_retained(&d, 99).unwrap().slot, 100);
        // Nothing at or before 97 retained, and 98 or 99 may have been
        // evicted rather than skipped: unknown.
        assert_eq!(first_after(&d, 97).unwrap().slot, 100);
        assert_eq!(first_after_retained(&d, 97), None);
        assert_eq!(first_after_retained(&build(&[]), 1), None);
    }

    #[test]
    fn malformed_buffers() {
        assert_eq!(len(&[]), None);
        let mut d = build(&[5, 4]);
        d.truncate(8 + 40 + 39);
        assert_eq!(len(&d), None);
        let d = build(&[]);
        assert_eq!(len(&d), Some(0));
        assert_eq!(latest(&d), None);
        let mut too_many = build(&[1]);
        too_many[..8].copy_from_slice(&(513u64).to_le_bytes());
        assert_eq!(len(&too_many), None);
    }
}
