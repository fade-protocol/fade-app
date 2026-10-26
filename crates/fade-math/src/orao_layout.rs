//! Byte layouts of the ORAO VRF accounts Fade reads, verified against the
//! vendored IDL (`tests/fixtures/orao/orao_vrf.json`), against devnet on
//! 17 September 2026 and, for the legacy `Randomness`, against the mainnet
//! binary and fulfilled mainnet accounts on 22 September 2026. Fade never links
//! ORAO's crate; these are the only facts it depends on.

/// `sha256("global:request_v2")[..8]`.
pub const REQUEST_V2_DISCRIMINATOR: [u8; 8] = [38, 151, 209, 6, 195, 102, 28, 217];
/// Account discriminator of `RandomnessV2`.
pub const RANDOMNESS_V2_DISCRIMINATOR: [u8; 8] = [139, 239, 184, 215, 227, 86, 191, 226];
/// Account discriminator of the legacy `Randomness`, which ORAO's deprecated
/// `request` still creates at the same address as `request_v2`.
pub const RANDOMNESS_V1_DISCRIMINATOR: [u8; 8] = [188, 96, 216, 248, 93, 94, 49, 112];
/// Size of a legacy `Randomness` account on mainnet, pending or fulfilled.
pub const V1_LEN: usize = 780;
/// PDA seed of the network state.
pub const NETWORK_STATE_SEED: &[u8] = b"orao-vrf-network-configuration";
/// PDA seed prefix of a request; the 32-byte seed follows.
pub const REQUEST_SEED: &[u8] = b"orao-vrf-randomness-request";
/// `NetworkState.config.treasury` offset (8-byte discriminator, 32-byte authority).
pub const TREASURY_OFFSET: usize = 40;
/// `NetworkState.config.request_fee` offset (u64 LE).
pub const REQUEST_FEE_OFFSET: usize = 72;
/// Size of a pending `RandomnessV2` account.
pub const PENDING_LEN: usize = 749;
/// Size of a fulfilled `RandomnessV2` account.
pub const FULFILLED_LEN: usize = 137;

/// The two fields of the network state Fade needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetworkState {
    /// Where the request fee goes; must be passed as the `treasury` account.
    pub treasury: [u8; 32],
    /// Fee per request, in lamports.
    pub request_fee: u64,
}

/// Parses the network state. The caller pins the account's address and owner.
pub fn network_state(data: &[u8]) -> Option<NetworkState> {
    let treasury: [u8; 32] = data
        .get(TREASURY_OFFSET..TREASURY_OFFSET.checked_add(32)?)?
        .try_into()
        .ok()?;
    let fee: [u8; 8] = data
        .get(REQUEST_FEE_OFFSET..REQUEST_FEE_OFFSET.checked_add(8)?)?
        .try_into()
        .ok()?;
    Some(NetworkState {
        treasury,
        request_fee: u64::from_le_bytes(fee),
    })
}

/// A request account, as much of it as settlement needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Randomness {
    /// Not enough authorities have answered yet.
    Pending,
    /// The quorum answered.
    Fulfilled {
        /// The seed the request was made with.
        seed: [u8; 32],
        /// The 64-byte randomness.
        randomness: [u8; 64],
    },
}

/// Parses a `RandomnessV2` account. Returns `None` for a wrong discriminator,
/// an unknown tag, or a truncated fulfilled account. The caller pins the
/// address (derived from the seed) and the owner (the ORAO program).
pub fn randomness_v2(data: &[u8]) -> Option<Randomness> {
    if data.get(..8)? != RANDOMNESS_V2_DISCRIMINATOR {
        return None;
    }
    match *data.get(8)? {
        0 => Some(Randomness::Pending),
        1 => {
            if data.len() < FULFILLED_LEN {
                return None;
            }
            let seed: [u8; 32] = data.get(41..73)?.try_into().ok()?;
            let randomness: [u8; 64] = data.get(73..137)?.try_into().ok()?;
            Some(Randomness::Fulfilled { seed, randomness })
        }
        _ => None,
    }
}

/// The client of a pending `RandomnessV2` request: whoever paid its rent,
/// which ORAO refunds to that address when it fulfils the request (the
/// fulfilled account is smaller). `None` for any other account, a legacy one
/// included: a legacy account never shrinks, so nothing is refunded there.
pub fn pending_v2_client(data: &[u8]) -> Option<[u8; 32]> {
    if data.get(..8)? != RANDOMNESS_V2_DISCRIMINATOR || *data.get(8)? != 0 {
        return None;
    }
    data.get(9..41)?.try_into().ok()
}

/// Parses a legacy `Randomness` account: discriminator, seed (32 bytes),
/// randomness (64 bytes, zero until the quorum answers), then the responses.
/// It never shrinks, so fulfilled and pending have the same length.
pub fn randomness_v1(data: &[u8]) -> Option<Randomness> {
    if data.get(..8)? != RANDOMNESS_V1_DISCRIMINATOR {
        return None;
    }
    let seed: [u8; 32] = data.get(8..40)?.try_into().ok()?;
    let randomness: [u8; 64] = data.get(40..104)?.try_into().ok()?;
    if randomness == [0u8; 64] {
        return Some(Randomness::Pending);
    }
    Some(Randomness::Fulfilled { seed, randomness })
}

/// Either kind of request. Anyone can create a legacy one at a request address
/// through ORAO's deprecated `request`, and ORAO fulfils it for the same seed,
/// so Fade accepts both rather than let that block a ticket.
pub fn randomness(data: &[u8]) -> Option<Randomness> {
    randomness_v2(data).or_else(|| randomness_v1(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fulfilled(seed: u8, r: u8) -> [u8; FULFILLED_LEN] {
        let mut d = [0u8; FULFILLED_LEN];
        d[..8].copy_from_slice(&RANDOMNESS_V2_DISCRIMINATOR);
        d[8] = 1;
        d[9..41].fill(7);
        d[41..73].fill(seed);
        d[73..137].fill(r);
        d
    }

    #[test]
    fn parses_fulfilled_and_rejects_everything_else() {
        let d = fulfilled(3, 9);
        assert_eq!(
            randomness_v2(&d),
            Some(Randomness::Fulfilled {
                seed: [3; 32],
                randomness: [9; 64]
            })
        );
        assert_eq!(randomness_v2(&d[..136]), None, "one byte short");
        let mut pending = d;
        pending[8] = 0;
        assert_eq!(randomness_v2(&pending), Some(Randomness::Pending));
        let mut tag = d;
        tag[8] = 2;
        assert_eq!(randomness_v2(&tag), None);
        let mut disc = d;
        disc[0] ^= 1;
        assert_eq!(randomness_v2(&disc), None);
        assert_eq!(randomness_v2(&[]), None);
    }

    #[test]
    fn reads_the_client_of_a_pending_v2_request_only() {
        let mut pending = [0u8; PENDING_LEN];
        pending[..8].copy_from_slice(&RANDOMNESS_V2_DISCRIMINATOR);
        pending[9..41].fill(5);
        assert_eq!(pending_v2_client(&pending), Some([5; 32]));
        assert_eq!(pending_v2_client(&pending[..40]), None, "truncated");
        let d = fulfilled(3, 9);
        assert_eq!(pending_v2_client(&d), None, "fulfilled: refunded already");
        let mut legacy = [0u8; V1_LEN];
        legacy[..8].copy_from_slice(&RANDOMNESS_V1_DISCRIMINATOR);
        assert_eq!(
            pending_v2_client(&legacy),
            None,
            "a legacy account refunds nothing"
        );
    }

    #[test]
    fn parses_the_legacy_layout_and_dispatches_on_the_discriminator() {
        let mut d = [0u8; V1_LEN];
        d[..8].copy_from_slice(&RANDOMNESS_V1_DISCRIMINATOR);
        d[8..40].fill(4);
        assert_eq!(randomness_v1(&d), Some(Randomness::Pending));
        assert_eq!(randomness(&d), Some(Randomness::Pending));
        d[40..104].fill(6);
        let fulfilled_v1 = Some(Randomness::Fulfilled {
            seed: [4; 32],
            randomness: [6; 64],
        });
        assert_eq!(randomness_v1(&d), fulfilled_v1);
        assert_eq!(randomness(&d), fulfilled_v1);
        assert_eq!(randomness_v2(&d), None);
        assert_eq!(randomness_v1(&d[..103]), None, "one byte short");
        let v2 = fulfilled(3, 9);
        assert_eq!(randomness_v1(&v2), None);
        assert_eq!(randomness(&v2), randomness_v2(&v2));
        let mut disc = d;
        disc[0] ^= 1;
        assert_eq!(randomness(&disc), None);
    }

    #[test]
    fn network_state_offsets() {
        let mut d = [0u8; 472];
        d[TREASURY_OFFSET..TREASURY_OFFSET + 32].fill(5);
        d[REQUEST_FEE_OFFSET..REQUEST_FEE_OFFSET + 8].copy_from_slice(&500_000u64.to_le_bytes());
        assert_eq!(
            network_state(&d),
            Some(NetworkState {
                treasury: [5; 32],
                request_fee: 500_000
            })
        );
        assert_eq!(network_state(&d[..79]), None);
    }
}
