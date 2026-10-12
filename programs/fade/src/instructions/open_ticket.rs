//! `open_ticket`: the one checkpoint of a ticket (Spec 07 §1–§2). Fade never
//! calls back into the integrator, so everything is validated here and
//! snapshotted into the ticket; settlement re-checks none of it.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{Mint, Token, TokenAccount};
use fade_math::orao_layout;
use fade_math::{payout_table, risk, BPS};

use crate::constants::*;
use crate::errors::{FadeError, OrFade};
use crate::events::{IntegratorCreated, TicketOpened};
use crate::instructions::common::{is_usdc_account, user_transfer};
use crate::state::{Config, Integrator, Outcome, Ticket, TicketStatus, Vault};

#[event_cpi]
#[derive(Accounts)]
#[instruction(price: u64, payout_table: Vec<Outcome>, app_share_bps: u64, nonce: u64)]
pub struct OpenTicket<'info> {
    /// The integrator's identity: a program signs with its `["fade-integrator"]`
    /// PDA through `invoke_signed`, a server or a wallet with its own key.
    pub integrator_authority: Signer<'info>,
    /// Pays the ticket's rent, the oracle prefund and the crank fee; receives
    /// every refund when the ticket closes.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Owns `funder_usdc`, pays the ticket price, and signs this very instruction: the
    /// user, or an app paying from funds it holds for its users or its own budget.
    pub funder: Signer<'info>,
    #[account(mut, token::mint = usdc_mint, token::authority = funder)]
    pub funder_usdc: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    /// Created by the integrator's first ticket; never re-initialised, never closed.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Integrator::INIT_SPACE,
        seeds = [INTEGRATOR_SEED, integrator_authority.key().as_ref()],
        bump,
    )]
    pub integrator: Box<Account<'info, Integrator>>,
    /// CHECK: a USDC token account, checked in the handler rather than typed so
    /// that it may be the funder's own USDC account — a user acting as its own
    /// integrator. Stored by the first ticket, and must equal the stored one after.
    #[account(mut)]
    pub share_account: UncheckedAccount<'info>,
    #[account(mut, address = config.protocol_treasury)]
    pub protocol_treasury: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [USDC_VAULT_SEED], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// Any legacy-SPL USDC account; stored, and the only place a payout can go.
    #[account(token::mint = usdc_mint)]
    pub beneficiary: Box<Account<'info, TokenAccount>>,
    /// Never `init_if_needed`: the address is nonce-scoped and one-shot.
    #[account(
        init,
        payer = payer,
        space = 8 + Ticket::INIT_SPACE,
        seeds = [TICKET_SEED, integrator.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, seeds = [VRF_PAYER_SEED, ticket.key().as_ref()], bump)]
    pub vrf_payer: SystemAccount<'info>,
    /// CHECK: ORAO's network state at the address derived from the pinned ORAO id,
    /// owner checked in the handler; the fee is read from it, never set by Fade.
    #[account(seeds = [orao_layout::NETWORK_STATE_SEED], bump, seeds::program = ORAO_VRF_ID)]
    pub orao_network_state: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ FadeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn open_ticket_handler(
    ctx: Context<OpenTicket>,
    price: u64,
    table: Vec<Outcome>,
    app_share_bps: u64,
    nonce: u64,
) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        FadeError::RemainingAccounts
    );
    let config = &ctx.accounts.config;
    let params = config.params;
    let math = params.to_math();
    require!(!config.is_paused(Config::PAUSE_TICKETS), FadeError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // --- who is calling ---------------------------------------------------------
    let integrator_key = ctx.accounts.integrator.key();
    let created = ctx.accounts.integrator.version == 0;
    {
        let integrator = &mut ctx.accounts.integrator;
        if created {
            require!(
                !config.is_paused(Config::PAUSE_NEW_INTEGRATORS),
                FadeError::Paused
            );
            integrator.version = ACCOUNT_VERSION;
            integrator.bump = ctx.bumps.integrator;
            integrator.authority = ctx.accounts.integrator_authority.key();
            integrator.share_account = ctx.accounts.share_account.key();
            integrator.created_at = now;
        }
        require!(!integrator.paused, FadeError::IntegratorPaused);
        require!(
            is_usdc_account(&ctx.accounts.share_account, &ctx.accounts.usdc_mint.key()),
            FadeError::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.share_account.key(),
            integrator.share_account,
            FadeError::ShareAccountMismatch
        );
        require!(nonce == integrator.next_nonce, FadeError::WrongNonce);
    }

    // --- does the payout table keep its margin ---------------------------------------------
    let outcomes: Vec<payout_table::Outcome> = table
        .iter()
        .map(|b| payout_table::Outcome { p: b.p, m: b.m })
        .collect();
    let summary = payout_table::validate(&outcomes).or_fade()?;
    let margin = payout_table::margin_bps(summary.lhs).ok_or(FadeError::PayoutTableOverpays)?;
    let vault_margin = risk::check_split(margin, app_share_bps, &math).or_fade()?;
    // The invariant itself, exactly: Σ p·m ≤ (1 − floor − shares) in u128.
    let floor = params
        .min_vault_margin_bps
        .checked_add(params.protocol_share_bps)
        .and_then(|v| v.checked_add(app_share_bps))
        .ok_or(FadeError::MathOverflow)?;
    require!(floor <= BPS, FadeError::MarginFloor);
    require!(
        payout_table::ev_ok(summary.lhs, floor),
        FadeError::MarginFloor
    );

    // --- is the vault still healthy ------------------------------------------------
    let vault = &mut ctx.accounts.vault;
    // Opening moves no settled asset: the credit is both owned and at risk.
    let share_price = vault.settled_price().or_fade()?;
    let mut ring = vault.ring();
    ring.observe(now, share_price, share_price);
    require!(
        !ring.tripped(share_price, params.drawdown_bps),
        FadeError::DrawdownBreaker
    );
    let halved = vault.drawdown_trip_ts != 0
        && now
            < vault
                .drawdown_trip_ts
                .checked_add(DRAWDOWN_AFTERMATH_SECONDS)
                .ok_or(FadeError::MathOverflow)?;

    // --- is the ticket sized right -------------------------------------------------
    let w = risk::ticket_for(price, summary.max_m, app_share_bps, &math).or_fade()?;
    let integrator_math = risk::Integrator {
        reserved: ctx.accounts.integrator.reserved_liability,
        volume_total: ctx.accounts.integrator.volume_total,
    };
    let admission = risk::admit(
        &vault.math(),
        &integrator_math,
        &math,
        &w,
        vault_margin,
        halved,
    )
    .or_fade()?;

    // --- the oracle's price, read from ORAO, never from Fade's admin ------------------
    let network = &ctx.accounts.orao_network_state;
    require_keys_eq!(
        *network.owner,
        ORAO_VRF_ID,
        FadeError::NetworkStateUnreadable
    );
    let state = orao_layout::network_state(&network.try_borrow_data()?)
        .ok_or(FadeError::NetworkStateUnreadable)?;
    let request_rent = Rent::get()?.minimum_balance(orao_layout::PENDING_LEN);
    // Twice the fee: ORAO's fee could rise between the open and the request,
    // and a request that cannot pay would leave the ticket to be forfeited.
    // Whatever is not spent goes back to the payer at close.
    let prefund = state
        .request_fee
        .checked_mul(2)
        .and_then(|v| v.checked_add(request_rent))
        .ok_or(FadeError::MathOverflow)?;
    let crank_fee = params.crank_fee_lamports().or_fade()?;

    // --- money moves: shares out of the ticket price, the credit into the vault ----------------
    let protocol_share = payout_table::share_of(price, params.protocol_share_bps).or_fade()?;
    let app_share = payout_table::share_of(price, app_share_bps).or_fade()?;
    let token_program = &ctx.accounts.token_program;
    let mint = &ctx.accounts.usdc_mint;
    let owner = ctx.accounts.funder.to_account_info();
    let source = &ctx.accounts.funder_usdc;
    user_transfer(
        token_program,
        source,
        ctx.accounts.protocol_treasury.to_account_info(),
        mint,
        owner.clone(),
        protocol_share,
    )?;
    user_transfer(
        token_program,
        source,
        ctx.accounts.share_account.to_account_info(),
        mint,
        owner.clone(),
        app_share,
    )?;
    user_transfer(
        token_program,
        source,
        ctx.accounts.vault_usdc.to_account_info(),
        mint,
        owner,
        w.vault_credit,
    )?;
    for (to, lamports) in [
        (ctx.accounts.vrf_payer.to_account_info(), prefund),
        (ctx.accounts.ticket.to_account_info(), crank_fee),
    ] {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to,
                },
            ),
            lamports,
        )?;
    }

    // --- the books ------------------------------------------------------------------
    let after = admission.vault_after;
    vault.total_assets = after.assets;
    vault.total_reserved_liability = after.reserved;
    vault.open_vault_credits = after.open_credits;
    vault.volume_total = vault.volume_total.saturating_add(price);
    let mut counters = vault.counters();
    let (side, generation) = counters.open(now).or_fade()?;
    vault.set_counters(&counters);
    vault.set_ring(&ring);
    if created {
        vault.integrators = vault.integrators.saturating_add(1);
    }

    let integrator = &mut ctx.accounts.integrator;
    integrator.reserved_liability = integrator
        .reserved_liability
        .checked_add(admission.liability)
        .ok_or(FadeError::MathOverflow)?;
    integrator.open_tickets = integrator
        .open_tickets
        .checked_add(1)
        .ok_or(FadeError::MathOverflow)?;
    integrator.next_nonce = integrator
        .next_nonce
        .checked_add(1)
        .ok_or(FadeError::MathOverflow)?;
    integrator.volume_total = integrator.volume_total.saturating_add(price);

    let ticket = &mut ctx.accounts.ticket;
    ticket.version = ACCOUNT_VERSION;
    ticket.bump = ctx.bumps.ticket;
    ticket.vrf_payer_bump = ctx.bumps.vrf_payer;
    ticket.status = TicketStatus::Open;
    ticket.integrator = integrator_key;
    ticket.nonce = nonce;
    ticket.payer = ctx.accounts.payer.key();
    ticket.beneficiary = ctx.accounts.beneficiary.key();
    ticket.price = price;
    ticket.vault_credit = w.vault_credit;
    ticket.payout_max = w.payout_max;
    ticket.reserved_liability = admission.liability;
    ticket.cap = admission.cap;
    ticket.margin_bps = margin;
    ticket.app_share_bps = app_share_bps;
    ticket.vault_margin_bps = vault_margin;
    ticket.drawdown_bps = params.drawdown_bps;
    ticket.open_slot = clock.slot;
    ticket.open_ts = now;
    ticket.expiry_slot = clock
        .slot
        .checked_add(params.t_settle_slots)
        .ok_or(FadeError::MathOverflow)?;
    ticket.side = Ticket::encode_side(side);
    ticket.generation = generation;
    ticket.crank_request_lamports = params.crank_request_lamports;
    ticket.crank_settle_lamports = params.crank_settle_lamports;
    ticket.payout_table_len = u8::try_from(table.len()).map_err(|_| FadeError::OutcomeCount)?;
    for (slot, b) in ticket.payout_table.iter_mut().zip(table.iter()) {
        *slot = *b;
    }

    if created {
        emit_cpi!(IntegratorCreated {
            version: EVENT_VERSION,
            integrator: integrator_key,
            authority: ctx.accounts.integrator_authority.key(),
            share_account: ctx.accounts.share_account.key(),
        });
    }
    emit_cpi!(TicketOpened {
        version: EVENT_VERSION,
        ticket: ctx.accounts.ticket.key(),
        integrator: integrator_key,
        nonce,
        beneficiary: ctx.accounts.beneficiary.key(),
        price,
        vault_credit: w.vault_credit,
        payout_max: w.payout_max,
        reserved_liability: admission.liability,
        cap: admission.cap,
        margin_bps: margin,
        app_share_bps,
        open_slot: clock.slot,
    });
    Ok(())
}
