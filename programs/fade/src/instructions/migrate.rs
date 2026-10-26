//! Devnet only: `migrate_config` (Spec 08 §13.5.13). The beacon appends six
//! fields to `RiskParams`, which sits twice in `Config` (`params` and
//! `pending.params`), so `Config` grows by 96 bytes and its layout version
//! becomes 2. A version-1 `Config` no longer deserialises, so every
//! instruction that reads it fails until it is migrated: the devnet
//! deployment migrates in place and keeps its vault, its integrators and its
//! liquidity providers. A mainnet build cannot carry the instruction (feature
//! "devnet", as "no-timelock"); the byte transformation is compiled for the
//! unit tests too, so it is tested without a devnet build.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::constants::CONFIG_VERSION;
use crate::errors::FadeError;
use crate::state::{Config, RiskParams};

/// The six beacon parameters, in `RiskParams` order (Spec 08 §13.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BeaconParams {
    pub beacon_min_price: u64,
    pub beacon_threshold: u64,
    pub round_k: u64,
    pub tick_slots: u64,
    pub refund_slots: u64,
    pub crank_round_settle_lamports: u64,
}

impl BeaconParams {
    /// The beacon part of `p`.
    pub fn of(p: &RiskParams) -> Self {
        BeaconParams {
            beacon_min_price: p.beacon_min_price,
            beacon_threshold: p.beacon_threshold,
            round_k: p.round_k,
            tick_slots: p.tick_slots,
            refund_slots: p.refund_slots,
            crank_round_settle_lamports: p.crank_round_settle_lamports,
        }
    }
}

/// Bytes the six fields add to one `RiskParams`.
pub const BEACON_PARAMS_LEN: usize = 6 * 8;
/// `RiskParams` before the beacon.
pub const V1_PARAMS_LEN: usize = RiskParams::INIT_SPACE - BEACON_PARAMS_LEN;
/// Where `params` starts: discriminator, `version`, `bump`,
/// `vault_authority_bump`, four keys, `pause_flags`. Unchanged by the
/// migration but for `PAUSE_ROUNDS`, which it sets.
pub const PARAMS_AT: usize = 8 + 3 + 4 * 32 + 1;
/// `pause_flags`, the byte before `params`.
const PAUSE_FLAGS_AT: usize = PARAMS_AT - 1;
/// `pending.active` and `pending.effective_at`, between the two `RiskParams`.
const PENDING_HEAD_LEN: usize = 1 + 8;
/// A version-1 `Config`, discriminator included: 695 bytes.
pub const V1_CONFIG_LEN: usize = 8 + Config::INIT_SPACE - 2 * BEACON_PARAMS_LEN;
/// A version-2 `Config`, discriminator included: 791 bytes.
pub const V2_CONFIG_LEN: usize = 8 + Config::INIT_SPACE;

/// The version-2 bytes of a version-1 `Config`: each `RiskParams` extended by
/// `beacon`, the version set to 2 and `PAUSE_ROUNDS` added to the pause
/// flags, every other byte kept. Refuses anything that is not exactly a
/// version-1 `Config`, and a result whose parameters `set_params` would refuse
/// (a pending change included): the migration changes nothing else.
pub fn migrated_config_data(old: &[u8], beacon: &BeaconParams) -> Result<Vec<u8>> {
    require!(
        old.len() == V1_CONFIG_LEN,
        anchor_lang::error::ErrorCode::AccountDidNotDeserialize
    );
    require!(
        old.get(..8) == Some(Config::DISCRIMINATOR),
        anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch
    );
    require!(
        old.get(8) == Some(&1),
        anchor_lang::error::ErrorCode::AccountDidNotDeserialize
    );
    let mut tail = Vec::with_capacity(BEACON_PARAMS_LEN);
    beacon.serialize(&mut tail)?;
    require!(
        tail.len() == BEACON_PARAMS_LEN,
        anchor_lang::error::ErrorCode::AccountDidNotSerialize
    );
    let params_end = PARAMS_AT + V1_PARAMS_LEN;
    let pending_params_end = params_end + PENDING_HEAD_LEN + V1_PARAMS_LEN;
    let piece = |from: usize, to: usize| -> Result<&[u8]> {
        old.get(from..to)
            .ok_or_else(|| error!(anchor_lang::error::ErrorCode::AccountDidNotDeserialize))
    };
    let mut new = Vec::with_capacity(V2_CONFIG_LEN);
    new.extend_from_slice(piece(0, params_end)?);
    new.extend_from_slice(&tail);
    new.extend_from_slice(piece(params_end, pending_params_end)?);
    new.extend_from_slice(&tail);
    new.extend_from_slice(piece(pending_params_end, V1_CONFIG_LEN)?);
    require!(
        new.len() == V2_CONFIG_LEN,
        anchor_lang::error::ErrorCode::AccountDidNotSerialize
    );
    if let Some(version) = new.get_mut(8) {
        *version = CONFIG_VERSION;
    }
    // The beacon starts paused, as after `initialize`: only the council turns
    // it on. Every other pause bit is kept.
    let pause = new
        .get_mut(PAUSE_FLAGS_AT)
        .ok_or_else(|| error!(anchor_lang::error::ErrorCode::AccountDidNotSerialize))?;
    *pause |= Config::PAUSE_ROUNDS;

    let config = Config::try_deserialize(&mut new.as_slice())?;
    require!(config.version == CONFIG_VERSION, FadeError::InvalidParams);
    require!(config.params.is_valid(), FadeError::InvalidParams);
    require!(
        !config.pending.active || config.pending.params.is_valid(),
        FadeError::InvalidParams
    );
    Ok(new)
}

#[cfg(feature = "devnet")]
pub use instruction::*;

#[cfg(feature = "devnet")]
mod instruction {
    use super::*;
    use crate::constants::{CONFIG_SEED, VAULT_SEED};
    use crate::state::Vault;
    use anchor_lang::system_program;

    #[derive(Accounts)]
    pub struct MigrateConfig<'info> {
        /// The program's upgrade authority, as for `initialize`; pays the rent
        /// the larger account needs.
        #[account(mut)]
        pub authority: Signer<'info>,
        #[account(constraint = fade_program.programdata_address()? == Some(program_data.key()) @ FadeError::NotUpgradeAuthority)]
        pub fade_program: Program<'info, crate::program::Fade>,
        #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ FadeError::NotUpgradeAuthority)]
        pub program_data: Box<Account<'info, ProgramData>>,
        /// CHECK: a version-1 `Config` does not deserialise as the current one;
        /// address and owner checked here, layout by `migrated_config_data`.
        #[account(mut, seeds = [CONFIG_SEED], bump, owner = crate::ID)]
        pub config: UncheckedAccount<'info>,
        #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
        pub vault: Box<Account<'info, Vault>>,
        pub system_program: Program<'info, System>,
    }

    /// Reallocates `Config` to version 2 with `beacon` appended to both
    /// `RiskParams`, tops its rent up from the authority, and starts the
    /// vault's round ids at 1 (a migrated `Vault` reads 0 from its former
    /// reserved tail). Once only: a second call finds a version-2 `Config`.
    pub fn migrate_config(ctx: Context<MigrateConfig>, beacon: BeaconParams) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        let new = {
            let data = info.try_borrow_data()?;
            migrated_config_data(&data, &beacon)?
        };
        let rent = Rent::get()?.minimum_balance(new.len());
        let lacking = rent.saturating_sub(info.lamports());
        if lacking > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: info.clone(),
                    },
                ),
                lacking,
            )?;
        }
        info.resize(new.len())?;
        info.try_borrow_mut_data()?.copy_from_slice(&new);

        let vault = &mut ctx.accounts.vault;
        if vault.next_round_id == 0 {
            vault.next_round_id = 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;

    /// The version-1 `RiskParams`, written field by field: an encoding
    /// independent of the offsets the migration computes.
    fn v1_params(p: &RiskParams, out: &mut Vec<u8>) {
        for v in [
            p.kelly_fraction_bps,
            p.censorship_bps,
            p.whale_bps,
            p.utilisation_breaker_bps,
            p.kappa_bps,
            p.drawdown_bps,
            p.min_price,
            p.max_price,
            p.min_vault_margin_bps,
            p.protocol_share_bps,
            p.max_app_share_bps,
            p.t_settle_slots,
            p.crank_request_lamports,
            p.crank_settle_lamports,
            p.epoch_length_seconds,
            p.claim_fee_lamports,
            p.strike_fee_lamports,
            p.strike_reward_lamports,
            p.fund_target_lamports,
            p.min_deposit,
            p.min_withdraw_shares,
            p.min_first_deposit,
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.push(u8::from(p.credit_enabled));
        out.extend_from_slice(&p.credit_base.to_le_bytes());
        out.extend_from_slice(&p.credit_rate_bps.to_le_bytes());
    }

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    /// A version-1 `Config` as the devnet program wrote it.
    fn v1_config(params: &RiskParams, pending: Option<(i64, RiskParams)>) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(Config::DISCRIMINATOR);
        d.extend_from_slice(&[1, 254, 253]);
        for b in [1, 2, 3, 4] {
            d.extend_from_slice(key(b).as_ref());
        }
        d.push(Config::PAUSE_DEPOSITS);
        v1_params(params, &mut d);
        let (active, at, pp) = match pending {
            Some((at, pp)) => (1u8, at, pp),
            None => (0u8, 0, *params),
        };
        d.push(active);
        d.extend_from_slice(&at.to_le_bytes());
        v1_params(&pp, &mut d);
        d.extend_from_slice(key(5).as_ref());
        d.extend_from_slice(&[7; 128]);
        d
    }

    fn devnet_params() -> RiskParams {
        let mut p = RiskParams::SPEC;
        p.min_price = 100_000;
        p.epoch_length_seconds = 120;
        p
    }

    #[test]
    fn the_layouts_are_the_pinned_ones() {
        assert_eq!(V1_CONFIG_LEN, 695, "the deployed version-1 Config");
        assert_eq!(V2_CONFIG_LEN, 791);
        assert_eq!(v1_config(&RiskParams::SPEC, None).len(), V1_CONFIG_LEN);
        // `params` starts where the migration splices: the serialised Config agrees.
        let mut c = Config {
            version: CONFIG_VERSION,
            bump: 0,
            vault_authority_bump: 0,
            council: key(1),
            guardian: key(2),
            protocol_treasury: key(3),
            usdc_mint: key(4),
            pause_flags: 0x5a,
            params: RiskParams::SPEC,
            pending: crate::state::PendingChange {
                active: false,
                effective_at: 0,
                params: RiskParams::SPEC,
                protocol_treasury: key(5),
            },
            _reserved: [0; 128],
        };
        c.params.kelly_fraction_bps = 0x0102_0304_0506_0708;
        let mut bytes = Vec::new();
        c.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), V2_CONFIG_LEN);
        assert_eq!(
            bytes[PARAMS_AT..PARAMS_AT + 8],
            0x0102_0304_0506_0708u64.to_le_bytes()
        );
        // And `pause_flags` sits where the migration sets `PAUSE_ROUNDS`.
        assert_eq!(bytes[PAUSE_FLAGS_AT], 0x5a);
    }

    #[test]
    fn a_version_1_config_migrates_with_every_other_field_kept() {
        let params = devnet_params();
        let mut queued = params;
        queued.censorship_bps = 200;
        let beacon = BeaconParams::of(&RiskParams::SPEC);
        let old = v1_config(&params, Some((1_234, queued)));
        let new = migrated_config_data(&old, &beacon).unwrap();
        let c = Config::try_deserialize(&mut new.as_slice()).unwrap();

        let extend = |p: RiskParams| RiskParams {
            beacon_min_price: beacon.beacon_min_price,
            beacon_threshold: beacon.beacon_threshold,
            round_k: beacon.round_k,
            tick_slots: beacon.tick_slots,
            refund_slots: beacon.refund_slots,
            crank_round_settle_lamports: beacon.crank_round_settle_lamports,
            ..p
        };
        assert_eq!(c.version, CONFIG_VERSION);
        assert_eq!((c.bump, c.vault_authority_bump), (254, 253));
        assert_eq!(
            [c.council, c.guardian, c.protocol_treasury, c.usdc_mint],
            [key(1), key(2), key(3), key(4)]
        );
        assert_eq!(
            c.pause_flags,
            Config::PAUSE_DEPOSITS | Config::PAUSE_ROUNDS,
            "the pauses kept, the beacon's added"
        );
        assert_eq!(c.params, extend(params));
        assert!(c.pending.active);
        assert_eq!(c.pending.effective_at, 1_234);
        assert_eq!(c.pending.params, extend(queued));
        assert_eq!(c.pending.protocol_treasury, key(5));
        assert_eq!(c._reserved, [7; 128]);
        // Re-serialising the result gives the same bytes: nothing is left over.
        let mut again = Vec::new();
        c.try_serialize(&mut again).unwrap();
        assert_eq!(again, new);
    }

    #[test]
    fn the_migration_refuses_anything_but_a_valid_version_1_config() {
        let beacon = BeaconParams::of(&RiskParams::SPEC);
        let old = v1_config(&devnet_params(), None);
        // Already migrated: a second call refuses.
        let new = migrated_config_data(&old, &beacon).unwrap();
        assert!(migrated_config_data(&new, &beacon).is_err());
        // Wrong discriminator, wrong version, wrong length.
        let mut d = old.clone();
        d[0] ^= 1;
        assert!(migrated_config_data(&d, &beacon).is_err());
        let mut d = old.clone();
        d[8] = 2;
        assert!(migrated_config_data(&d, &beacon).is_err());
        assert!(migrated_config_data(&old[..old.len() - 1], &beacon).is_err());
        // Beacon parameters set_params would refuse.
        for bad in [
            BeaconParams {
                round_k: 2,
                ..beacon
            },
            BeaconParams {
                round_k: 0,
                ..beacon
            },
            BeaconParams {
                tick_slots: 0,
                ..beacon
            },
            BeaconParams {
                refund_slots: beacon.tick_slots - 1,
                ..beacon
            },
            BeaconParams {
                beacon_threshold: beacon.beacon_min_price - 1,
                ..beacon
            },
            BeaconParams {
                crank_round_settle_lamports: 0,
                ..beacon
            },
        ] {
            assert!(migrated_config_data(&old, &bad).is_err(), "{bad:?}");
        }
        // An invalid pending change is not carried over silently.
        let mut queued = devnet_params();
        queued.crank_settle_lamports = beacon.crank_round_settle_lamports - 1;
        let old = v1_config(&devnet_params(), Some((5, queued)));
        assert!(migrated_config_data(&old, &beacon).is_err());
    }
}
