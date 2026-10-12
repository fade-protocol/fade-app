//! Harness shared by the transaction-level tests: LiteSVM on the mainnet
//! feature set, Fade, the test integrator and the ORAO stand-in loaded at
//! ORAO's address, a USDC mint the tests control, a clock and a SlotHashes
//! sysvar the tests advance, and a builder for every instruction.
#![allow(dead_code, clippy::too_many_arguments)]

use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use fade::state::{Config, EpochRecord, Integrator, Outcome, Queue, RiskParams, Ticket, Vault};
use fade_math::orao_layout;
use fade_testkit::{token, upgradeable};
use litesvm::types::TransactionMetadata;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

pub type Pk = anchor_lang::prelude::Pubkey;

pub const USDC: u64 = 1_000_000;
pub const SHARE: u64 = 1_000_000_000;
pub const ORAO_FEE: u64 = 500_000;
/// A Unix time on the 600 s grid plus 100 s: the first epoch closes 500 s later.
pub const T0: i64 = 1_790_000_000 - 1_790_000_000 % 600 + 100;

pub fn addr(p: Pk) -> Address {
    Address::new_from_array(p.to_bytes())
}
pub fn pk(a: Address) -> Pk {
    Pk::new_from_array(a.to_bytes())
}
pub fn metas(v: Vec<anchor_lang::prelude::AccountMeta>) -> Vec<AccountMeta> {
    v.into_iter()
        .map(|m| AccountMeta {
            pubkey: addr(m.pubkey),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect()
}
pub fn fade_id() -> Address {
    addr(fade::ID)
}
pub fn orao_id() -> Address {
    addr(fade::ORAO_VRF_ID)
}
pub fn system_id() -> Address {
    Address::new_from_array(solana_sdk_ids::system_program::ID.to_bytes())
}
pub fn ata_program_id() -> Address {
    Address::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
}
pub fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}
pub fn ata(owner: &Address, mint: &Address) -> Address {
    pda(
        &[
            owner.as_ref(),
            token::token_program_id().as_ref(),
            mint.as_ref(),
        ],
        &ata_program_id(),
    )
}
pub fn fade_pda(seeds: &[&[u8]]) -> Address {
    pda(seeds, &fade_id())
}

/// Fade's program-derived addresses.
pub struct Addrs {
    pub config: Address,
    pub vault: Address,
    pub queue: Address,
    pub vault_authority: Address,
    pub vault_usdc: Address,
    pub payout_escrow: Address,
    pub deposit_queue: Address,
    pub payable: Address,
    pub share_mint: Address,
    pub share_escrow: Address,
    pub share_claims: Address,
    pub event_authority: Address,
    pub network_state: Address,
    pub usdc_mint: Address,
}

impl Addrs {
    fn new() -> Self {
        Addrs {
            config: fade_pda(&[fade::CONFIG_SEED]),
            vault: fade_pda(&[fade::VAULT_SEED]),
            queue: fade_pda(&[fade::QUEUE_SEED]),
            vault_authority: fade_pda(&[fade::VAULT_AUTHORITY_SEED]),
            vault_usdc: fade_pda(&[fade::USDC_VAULT_SEED]),
            payout_escrow: fade_pda(&[fade::PAYOUT_ESCROW_SEED]),
            deposit_queue: fade_pda(&[fade::DEPOSIT_QUEUE_SEED]),
            payable: fade_pda(&[fade::PAYABLE_SEED]),
            share_mint: fade_pda(&[fade::SHARE_MINT_SEED]),
            share_escrow: fade_pda(&[fade::SHARE_ESCROW_SEED]),
            share_claims: fade_pda(&[fade::SHARE_CLAIMS_SEED]),
            event_authority: fade_pda(&[b"__event_authority"]),
            network_state: pda(&[orao_layout::NETWORK_STATE_SEED], &orao_id()),
            usdc_mint: token::usdc_mint(),
        }
    }
}

/// Someone with SOL and a USDC account at their canonical address.
pub struct User {
    pub kp: Keypair,
    pub usdc: Address,
}

impl User {
    pub fn key(&self) -> Address {
        self.kp.pubkey()
    }
    pub fn shares(&self) -> Address {
        ata(&self.kp.pubkey(), &Addrs::new().share_mint)
    }
}

/// The failure of a transaction: the error and the logs.
#[derive(Debug)]
pub struct Failure {
    pub err: String,
    pub logs: Vec<String>,
}

impl Failure {
    /// Anchor custom errors surface as `Custom(n)`; Fade's start at 6000.
    pub fn has_code(&self, code: u32) -> bool {
        self.err.contains(&format!("Custom({code})"))
    }
}

pub fn fade_error(e: fade::errors::FadeError) -> u32 {
    6000 + e as u32
}

#[track_caller]
pub fn assert_fails_with<T: std::fmt::Debug>(
    result: Result<T, Failure>,
    e: fade::errors::FadeError,
) {
    let code = fade_error(e);
    match result {
        Ok(v) => panic!("expected {e:?} ({code}), got success {v:?}"),
        Err(f) => assert!(
            f.has_code(code),
            "expected {e:?} ({code}), got {}\n{}",
            f.err,
            f.logs.join("\n")
        ),
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub a: Addrs,
    pub deployer: Keypair,
    pub council: Keypair,
    pub guardian: Keypair,
    pub treasury: Address,
    pub orao_treasury: Address,
    /// A funded keypair that pays for keeper transactions.
    pub keeper: Keypair,
}

impl Env {
    /// Everything up to and including `initialize` with the specification's parameters.
    pub fn new() -> Self {
        Self::with_params(RiskParams::SPEC)
    }

    pub fn with_params(params: RiskParams) -> Self {
        let mut env = Self::bare();
        env.initialize(params).expect("initialize");
        env
    }

    /// The programs and accounts, before `initialize`.
    pub fn bare() -> Self {
        let mut svm = fade_testkit::litesvm(fade_id(), &fade_testkit::program_path("fade"));
        svm.add_program_from_file(
            addr(test_integrator::ID),
            fade_testkit::program_path("test_integrator"),
        )
        .unwrap();
        svm.add_program_from_file(orao_id(), fade_testkit::program_path("orao_mock"))
            .unwrap();
        let a = Addrs::new();
        let deployer = Keypair::new();
        let council = Keypair::new();
        let guardian = Keypair::new();
        let keeper = Keypair::new();
        upgradeable::set_upgrade_authority(&mut svm, &fade_id(), &deployer.pubkey());
        for k in [&deployer, &council, &guardian, &keeper] {
            svm.airdrop(&k.pubkey(), 1_000_000_000_000).unwrap();
        }
        let mint_authority = Address::new_unique();
        token::write_mint(&mut svm, a.usdc_mint, &mint_authority, 6);
        let treasury = Address::new_unique();
        token::write_token_account(&mut svm, treasury, &a.usdc_mint, &council.pubkey(), 0);

        // ORAO's network state: discriminator, authority, treasury, fee, no
        // fulfilment authorities, no token fee, request counter.
        let orao_treasury = Address::new_unique();
        svm.airdrop(&orao_treasury, 1_000_000_000).unwrap();
        let mut state = vec![212u8, 237, 148, 56, 97, 245, 51, 169];
        state.extend_from_slice(Address::new_unique().as_ref());
        state.extend_from_slice(orao_treasury.as_ref());
        state.extend_from_slice(&ORAO_FEE.to_le_bytes());
        state.extend_from_slice(&0u32.to_le_bytes());
        state.push(0);
        state.extend_from_slice(&0u64.to_le_bytes());
        let lamports = svm.minimum_balance_for_rent_exemption(state.len());
        svm.set_account(
            a.network_state,
            Account {
                lamports,
                data: state,
                owner: orao_id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        let mut env = Env {
            svm,
            a,
            deployer,
            council,
            guardian,
            treasury,
            orao_treasury,
            keeper,
        };
        let slot = env.clock().slot;
        env.set_time(slot, T0);
        env
    }

    // --- clock and SlotHashes ------------------------------------------------------

    pub fn clock(&self) -> Clock {
        self.svm.get_sysvar::<Clock>()
    }
    pub fn now(&self) -> i64 {
        self.clock().unix_timestamp
    }
    pub fn slot(&self) -> u64 {
        self.clock().slot
    }

    /// Sets the clock and rewrites SlotHashes with the 512 slots before `slot`,
    /// skipping every slot listed in `skipped`.
    pub fn set_time_skipping(&mut self, slot: u64, unix: i64, skipped: &[u64]) {
        let mut clock = self.clock();
        clock.slot = slot;
        clock.unix_timestamp = unix;
        self.svm.set_sysvar(&clock);
        let mut entries = Vec::new();
        let mut s = slot;
        while entries.len() < 512 && s > 0 {
            s -= 1;
            if skipped.contains(&s) {
                continue;
            }
            entries.push(s);
        }
        let mut data = vec![0u8; 20_488];
        data[..8].copy_from_slice(&(entries.len() as u64).to_le_bytes());
        for (i, e) in entries.iter().enumerate() {
            let off = 8 + i * 40;
            data[off..off + 8].copy_from_slice(&e.to_le_bytes());
            data[off + 8..off + 40].copy_from_slice(&slot_hash(*e));
        }
        let sysvar_owner =
            Address::from_str("Sysvar1111111111111111111111111111111111111").unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                addr(fade::SLOT_HASHES_ID),
                Account {
                    lamports,
                    data,
                    owner: sysvar_owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    pub fn set_time(&mut self, slot: u64, unix: i64) {
        self.set_time_skipping(slot, unix, &[]);
    }

    /// Advances the clock by `slots` slots and `seconds` seconds.
    pub fn advance(&mut self, slots: u64, seconds: i64) {
        let c = self.clock();
        self.set_time(c.slot + slots, c.unix_timestamp + seconds);
    }

    // --- transactions ----------------------------------------------------------------

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, Failure> {
        let payer = signers[0];
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&payer.pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map_err(|e| Failure {
            err: format!("{:?}", e.err),
            logs: e.meta.logs,
        })
    }

    pub fn user(&mut self, usdc: u64) -> User {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        let account = ata(&kp.pubkey(), &self.a.usdc_mint);
        token::write_token_account(
            &mut self.svm,
            account,
            &self.a.usdc_mint,
            &kp.pubkey(),
            usdc,
        );
        User { kp, usdc: account }
    }

    pub fn usdc_account(&mut self, owner: &Address, amount: u64) -> Address {
        let account = Address::new_unique();
        token::write_token_account(&mut self.svm, account, &self.a.usdc_mint, owner, amount);
        account
    }

    /// Sets a token account's state byte: 1 initialised, 2 frozen.
    pub fn set_token_state(&mut self, account: &Address, state: u8) {
        let mut acc = self.svm.get_account(account).unwrap();
        acc.data[108] = state;
        self.svm.set_account(*account, acc).unwrap();
    }

    pub fn balance(&self, account: &Address) -> u64 {
        token::balance(&self.svm, account)
    }
    pub fn lamports(&self, account: &Address) -> u64 {
        self.svm.get_balance(account).unwrap_or(0)
    }
    pub fn exists(&self, account: &Address) -> bool {
        self.svm
            .get_account(account)
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    pub fn read<T: AccountDeserialize>(&self, address: &Address) -> T {
        let acc = self.svm.get_account(address).expect("account exists");
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialises")
    }
    pub fn config(&self) -> Config {
        self.read(&self.a.config)
    }
    pub fn vault(&self) -> Vault {
        self.read(&self.a.vault)
    }

    /// Test-only: rewrites the vault account in place.
    pub fn set_vault(&mut self, f: impl FnOnce(&mut Vault)) {
        let address = self.a.vault;
        let mut account = self.svm.get_account(&address).unwrap();
        let mut vault = Vault::try_deserialize(&mut account.data.as_slice()).unwrap();
        f(&mut vault);
        let mut data = Vec::new();
        vault.try_serialize(&mut data).unwrap();
        account.data[..data.len()].copy_from_slice(&data);
        self.svm.set_account(address, account).unwrap();
    }

    /// Test-only: a reservation, with no ticket behind it, such that what may
    /// leave the vault at the next strike is as close to `target` as the
    /// reservation's granularity allows, never above it. Undo with
    /// `set_vault(|p| p.total_reserved_liability = 0)` after the strike.
    pub fn pin_withdrawable(&mut self, target: u64) -> u64 {
        let params = self.config().params.to_math();
        let vault = self.vault();
        let deposits = self.queue().current.deposits;
        let at = |reserved: u64| {
            fade_math::risk::withdrawable(
                &fade_math::risk::Vault {
                    assets: vault.total_assets + deposits,
                    reserved,
                    open_credits: vault.open_vault_credits,
                },
                &params,
            )
        };
        // withdrawable falls as the reservation grows: the smallest one at or below target.
        let (mut lo, mut hi) = (0u64, vault.total_assets + deposits);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if at(mid) <= target {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        self.set_vault(|p| p.total_reserved_liability = lo);
        at(lo)
    }
    pub fn queue(&self) -> Queue {
        self.read(&self.a.queue)
    }
    pub fn record(&self, epoch_id: u64) -> EpochRecord {
        self.read(&self.record_address(epoch_id))
    }
    pub fn record_address(&self, epoch_id: u64) -> Address {
        fade_pda(&[fade::EPOCH_SEED, &epoch_id.to_le_bytes()])
    }
    /// The strike fund: the queue's lamports above its rent-exempt minimum.
    pub fn fund(&self) -> u64 {
        let acc = self.svm.get_account(&self.a.queue).unwrap();
        acc.lamports - self.svm.minimum_balance_for_rent_exemption(acc.data.len())
    }

    // --- governance ----------------------------------------------------------------

    pub fn initialize_ix(&self, payer: &Address, params: RiskParams) -> Instruction {
        let a = &self.a;
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::Initialize {
                    payer: pk(*payer),
                    fade_program: fade::ID,
                    program_data: pk(upgradeable::program_data_address(&fade_id())),
                    config: pk(a.config),
                    vault: pk(a.vault),
                    queue: pk(a.queue),
                    vault_authority: pk(a.vault_authority),
                    usdc_mint: pk(a.usdc_mint),
                    vault_usdc: pk(a.vault_usdc),
                    payout_escrow: pk(a.payout_escrow),
                    deposit_queue_usdc: pk(a.deposit_queue),
                    payable_usdc: pk(a.payable),
                    share_mint: pk(a.share_mint),
                    share_escrow: pk(a.share_escrow),
                    share_claims: pk(a.share_claims),
                    protocol_treasury: pk(self.treasury),
                    token_program: pk(token::token_program_id()),
                    system_program: pk(system_id()),
                    event_authority: pk(a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::Initialize {
                council: pk(self.council.pubkey()),
                guardian: pk(self.guardian.pubkey()),
                params,
            }
            .data(),
        }
    }

    pub fn initialize(&mut self, params: RiskParams) -> Result<TransactionMetadata, Failure> {
        let ix = self.initialize_ix(&self.deployer.pubkey(), params);
        let deployer = self.deployer.insecure_clone();
        self.send(&[ix], &[&deployer])
    }

    pub fn set_params_ix(
        &self,
        signer: &Address,
        params: RiskParams,
        treasury: &Address,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SetParams {
                    council: pk(*signer),
                    config: pk(self.a.config),
                    protocol_treasury: pk(*treasury),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::SetParams { params }.data(),
        }
    }

    pub fn set_params(&mut self, params: RiskParams) -> Result<TransactionMetadata, Failure> {
        let ix = self.set_params_ix(
            &self.council.pubkey(),
            params,
            &self.config().protocol_treasury_address(),
        );
        let council = self.council.insecure_clone();
        self.send(&[ix], &[&council])
    }

    pub fn apply_params(&mut self) -> Result<TransactionMetadata, Failure> {
        let ix = Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ApplyParams {
                    config: pk(self.a.config),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ApplyParams {}.data(),
        };
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    pub fn cancel_params(&mut self, signer: &Keypair) -> Result<TransactionMetadata, Failure> {
        let ix = Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::CancelParams {
                    council: pk(signer.pubkey()),
                    config: pk(self.a.config),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::CancelParams {}.data(),
        };
        self.send(&[ix], &[signer])
    }

    pub fn set_pause_flags(
        &mut self,
        signer: &Keypair,
        flags: u8,
        integrator: Option<(Address, bool)>,
    ) -> Result<TransactionMetadata, Failure> {
        let ix = Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SetPauseFlags {
                    authority: pk(signer.pubkey()),
                    config: pk(self.a.config),
                    integrator: integrator.map(|(i, _)| pk(i)),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::SetPauseFlags {
                pause_flags: flags,
                integrator_paused: integrator.map(|(_, p)| p),
            }
            .data(),
        };
        self.send(&[ix], &[signer])
    }

    // --- tickets ------------------------------------------------------------------------

    pub fn integrator_address(&self, authority: &Address) -> Address {
        fade_pda(&[fade::INTEGRATOR_SEED, authority.as_ref()])
    }
    pub fn ticket_address(&self, authority: &Address, nonce: u64) -> Address {
        let integrator = self.integrator_address(authority);
        fade_pda(&[fade::TICKET_SEED, integrator.as_ref(), &nonce.to_le_bytes()])
    }
    pub fn vrf_payer(&self, ticket: &Address) -> Address {
        fade_pda(&[fade::VRF_PAYER_SEED, ticket.as_ref()])
    }
    pub fn next_nonce(&self, authority: &Address) -> u64 {
        let address = self.integrator_address(authority);
        if self.exists(&address) {
            self.read::<Integrator>(&address).next_nonce
        } else {
            0
        }
    }
    pub fn ticket(&self, address: &Address) -> Ticket {
        self.read(address)
    }

    pub fn open_ticket_ix(&self, w: &OpenArgs) -> Instruction {
        let integrator = self.integrator_address(&w.authority);
        let ticket = self.ticket_address(&w.authority, w.nonce);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::OpenTicket {
                    integrator_authority: pk(w.authority),
                    payer: pk(w.payer),
                    funder: pk(w.funder),
                    funder_usdc: pk(w.funder_usdc),
                    config: pk(self.a.config),
                    vault: pk(self.a.vault),
                    integrator: pk(integrator),
                    share_account: pk(w.share_account),
                    protocol_treasury: pk(self.treasury),
                    vault_usdc: pk(self.a.vault_usdc),
                    beneficiary: pk(w.beneficiary),
                    ticket: pk(ticket),
                    vrf_payer: pk(self.vrf_payer(&ticket)),
                    orao_network_state: pk(self.a.network_state),
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::OpenTicket {
                price: w.price,
                payout_table: w.payout_table.clone(),
                app_share_bps: w.app_share_bps,
                nonce: w.nonce,
            }
            .data(),
        }
    }

    /// A player acting as its own integrator: it signs as the integrator, pays
    /// and ticket prices from its own account, and is its own beneficiary and share account.
    pub fn open_direct(
        &mut self,
        player: &User,
        price: u64,
        payout_table: &[Outcome],
        app_share_bps: u64,
    ) -> Result<Address, Failure> {
        let args = OpenArgs::direct(self, player, price, payout_table, app_share_bps);
        let ix = self.open_ticket_ix(&args);
        let kp = player.kp.insecure_clone();
        self.send(&[ix], &[&kp])?;
        Ok(self.ticket_address(&player.key(), args.nonce))
    }

    pub fn request_address(&self, ticket: &Address) -> Address {
        let w = self.ticket(ticket);
        let data = self
            .svm
            .get_account(&addr(fade::SLOT_HASHES_ID))
            .unwrap()
            .data;
        let e = fade_math::slot_hashes::first_after(&data, w.open_slot).expect("entropy slot");
        let seed = fade::instructions::request_randomness::orao_seed(
            &fade::ID,
            &pk(*ticket),
            w.open_slot,
            e.slot,
            &e.hash,
        );
        pda(&[orao_layout::REQUEST_SEED, &seed], &orao_id())
    }

    pub fn request_randomness_ix(
        &self,
        caller: &Address,
        ticket: &Address,
        request: &Address,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RequestRandomness {
                    caller: pk(*caller),
                    ticket: pk(*ticket),
                    vrf_payer: pk(self.vrf_payer(ticket)),
                    slot_hashes: fade::SLOT_HASHES_ID,
                    orao_network_state: pk(self.a.network_state),
                    orao_treasury: pk(self.orao_treasury),
                    request: pk(*request),
                    orao_program: fade::ORAO_VRF_ID,
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::RequestRandomness {}.data(),
        }
    }

    /// Advances two slots and requests the randomness as the keeper.
    pub fn request_randomness(&mut self, ticket: &Address) -> Result<Address, Failure> {
        self.advance(2, 1);
        let request = self.request_address(ticket);
        let ix = self.request_randomness_ix(&self.keeper.pubkey(), ticket, &request);
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])?;
        Ok(request)
    }

    /// ORAO's quorum writes `randomness` into the request.
    pub fn fulfill(&mut self, request: &Address, randomness: [u8; 64]) {
        let client = {
            let data = self.svm.get_account(request).unwrap().data;
            if data[..8] == orao_layout::RANDOMNESS_V1_DISCRIMINATOR {
                // Unused: a legacy request refunds nothing.
                self.keeper.pubkey()
            } else {
                Address::try_from(&data[9..41]).unwrap()
            }
        };
        let ix = Instruction {
            program_id: orao_id(),
            accounts: metas(
                orao_mock::accounts::Fulfill {
                    request: pk(*request),
                    client: pk(client),
                }
                .to_account_metas(None),
            ),
            data: orao_mock::instruction::Fulfill { randomness }.data(),
        };
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper]).expect("fulfil");
    }

    /// A randomness value whose outcome for `ticket` is outcome `want`.
    pub fn randomness_for(&self, ticket: &Address, want: usize) -> [u8; 64] {
        let w = self.ticket(ticket);
        let outcomes = w.outcomes();
        let summary = fade_math::payout_table::validate(&outcomes).unwrap();
        for i in 0u64.. {
            let mut r = [0u8; 64];
            r[..8].copy_from_slice(&i.to_le_bytes());
            r[63] = 1;
            let draw = fade_math::select::draw(
                |k| {
                    fade::instructions::settle::outcome_hash(
                        &fade::ID,
                        &pk(*ticket),
                        &w.seed,
                        &r,
                        k,
                    )
                },
                fade::OUTCOME_ROUNDS,
            )
            .unwrap();
            if fade_math::select::outcome(draw, &summary.cum, summary.len) == Some(want) {
                return r;
            }
        }
        unreachable!()
    }

    pub fn settle_ix(&self, caller: &Address, ticket: &Address) -> Instruction {
        let w = self.ticket(ticket);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SettleTicket {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    vault: pk(self.a.vault),
                    integrator: w.integrator,
                    ticket: pk(*ticket),
                    vrf_payer: pk(self.vrf_payer(ticket)),
                    randomness: w.randomness,
                    beneficiary: w.beneficiary,
                    payout_escrow: pk(self.a.payout_escrow),
                    vault_usdc: pk(self.a.vault_usdc),
                    vault_authority: pk(self.a.vault_authority),
                    payer: w.payer,
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::SettleTicket {}.data(),
        }
    }

    pub fn settle(&mut self, ticket: &Address) -> Result<TransactionMetadata, Failure> {
        let ix = self.settle_ix(&self.keeper.pubkey(), ticket);
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    /// Request, fulfil so that the outcome is `outcome`, settle.
    pub fn play_out(&mut self, ticket: &Address, outcome: usize) {
        let request = self.request_randomness(ticket).expect("request");
        let r = self.randomness_for(ticket, outcome);
        self.fulfill(&request, r);
        self.settle(ticket).expect("settle");
    }

    /// Plays out many tickets at once — one request slot for all of them, so
    /// that none drifts past `T_SETTLE` — each with outcome `outcome`.
    pub fn play_out_all(&mut self, tickets: &[Address], outcome: usize) {
        self.advance(2, 1);
        let keeper = self.keeper.insecure_clone();
        let mut requests = Vec::new();
        for w in tickets {
            let request = self.request_address(w);
            let ix = self.request_randomness_ix(&keeper.pubkey(), w, &request);
            self.send(&[ix], &[&keeper]).expect("request");
            requests.push(request);
        }
        for (w, request) in tickets.iter().zip(&requests) {
            let r = self.randomness_for(w, outcome);
            self.fulfill(request, r);
            self.settle(w).expect("settle");
        }
    }

    pub fn expire_ix(
        &self,
        caller: &Address,
        ticket: &Address,
        randomness: &Address,
    ) -> Instruction {
        let w = self.ticket(ticket);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ExpireTicket {
                    caller: pk(*caller),
                    vault: pk(self.a.vault),
                    integrator: w.integrator,
                    ticket: pk(*ticket),
                    vrf_payer: pk(self.vrf_payer(ticket)),
                    randomness: pk(*randomness),
                    payer: w.payer,
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ExpireTicket {}.data(),
        }
    }

    pub fn expire(&mut self, ticket: &Address) -> Result<TransactionMetadata, Failure> {
        let w = self.ticket(ticket);
        let randomness = if w.randomness == Pk::default() {
            system_id()
        } else {
            addr(w.randomness)
        };
        let ix = self.expire_ix(&self.keeper.pubkey(), ticket, &randomness);
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    pub fn claim_payout(&mut self, ticket: &Address) -> Result<TransactionMetadata, Failure> {
        let w = self.ticket(ticket);
        let ix = Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ClaimPayout {
                    caller: pk(self.keeper.pubkey()),
                    config: pk(self.a.config),
                    ticket: pk(*ticket),
                    beneficiary: w.beneficiary,
                    payout_escrow: pk(self.a.payout_escrow),
                    vault_authority: pk(self.a.vault_authority),
                    payer: w.payer,
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ClaimPayout {}.data(),
        };
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    // --- liquidity providers -----------------------------------------------------------

    /// The epoch a request made now joins, as the program computes it.
    pub fn joining_epoch(&self) -> u64 {
        self.queue().joining_epoch_id(self.now())
    }
    /// Whether a request made now opens an epoch.
    pub fn opens_epoch(&self) -> bool {
        !self.queue().current.live
    }
    pub fn deposit_request_address(&self, epoch_id: u64, owner: &Address) -> Address {
        fade_pda(&[fade::DEPOSIT_SEED, &epoch_id.to_le_bytes(), owner.as_ref()])
    }
    pub fn withdraw_request_address(&self, epoch_id: u64, owner: &Address) -> Address {
        fade_pda(&[fade::WITHDRAW_SEED, &epoch_id.to_le_bytes(), owner.as_ref()])
    }

    pub fn request_deposit_ix(&self, owner: &User, amount: u64) -> Instruction {
        let epoch = self.joining_epoch();
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RequestDeposit {
                    owner: pk(owner.key()),
                    owner_usdc: pk(owner.usdc),
                    owner_shares: pk(owner.shares()),
                    config: pk(self.a.config),
                    queue: pk(self.a.queue),
                    vault: self.opens_epoch().then(|| pk(self.a.vault)),
                    deposit_queue_usdc: pk(self.a.deposit_queue),
                    share_mint: pk(self.a.share_mint),
                    usdc_mint: pk(self.a.usdc_mint),
                    clock: pk(
                        Address::from_str("SysvarC1ock11111111111111111111111111111111").unwrap(),
                    ),
                    request: pk(self.deposit_request_address(epoch, &owner.key())),
                    instructions: fade::INSTRUCTIONS_SYSVAR_ID,
                    token_program: pk(token::token_program_id()),
                    associated_token_program: pk(ata_program_id()),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::RequestDeposit { amount }.data(),
        }
    }

    pub fn deposit(&mut self, owner: &User, amount: u64) -> Result<u64, Failure> {
        let epoch = self.joining_epoch();
        let ix = self.request_deposit_ix(owner, amount);
        let kp = owner.kp.insecure_clone();
        self.send(&[ix], &[&kp])?;
        Ok(epoch)
    }

    pub fn request_withdraw_ix(&self, owner: &User, shares: u64) -> Instruction {
        let epoch = self.joining_epoch();
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RequestWithdraw {
                    owner: pk(owner.key()),
                    owner_shares: pk(owner.shares()),
                    owner_usdc: pk(owner.usdc),
                    config: pk(self.a.config),
                    queue: pk(self.a.queue),
                    vault: self.opens_epoch().then(|| pk(self.a.vault)),
                    share_escrow: pk(self.a.share_escrow),
                    share_mint: pk(self.a.share_mint),
                    usdc_mint: pk(self.a.usdc_mint),
                    clock: pk(
                        Address::from_str("SysvarC1ock11111111111111111111111111111111").unwrap(),
                    ),
                    request: pk(self.withdraw_request_address(epoch, &owner.key())),
                    instructions: fade::INSTRUCTIONS_SYSVAR_ID,
                    token_program: pk(token::token_program_id()),
                    associated_token_program: pk(ata_program_id()),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::RequestWithdraw { shares }.data(),
        }
    }

    pub fn withdraw(&mut self, owner: &User, shares: u64) -> Result<u64, Failure> {
        let epoch = self.joining_epoch();
        let ix = self.request_withdraw_ix(owner, shares);
        let kp = owner.kp.insecure_clone();
        self.send(&[ix], &[&kp])?;
        Ok(epoch)
    }

    pub fn strike_ix(&self, caller: &Address) -> Instruction {
        let epoch = self.queue().current.epoch_id;
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::StrikeEpoch {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    queue: pk(self.a.queue),
                    vault: pk(self.a.vault),
                    record: pk(self.record_address(epoch)),
                    deposit_queue_usdc: pk(self.a.deposit_queue),
                    vault_usdc: pk(self.a.vault_usdc),
                    payable_usdc: pk(self.a.payable),
                    share_mint: pk(self.a.share_mint),
                    share_escrow: pk(self.a.share_escrow),
                    share_claims: pk(self.a.share_claims),
                    vault_authority: pk(self.a.vault_authority),
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::StrikeEpoch {}.data(),
        }
    }

    /// Strikes the live epoch as the keeper; returns its id.
    pub fn strike(&mut self) -> Result<u64, Failure> {
        let epoch = self.queue().current.epoch_id;
        let ix = self.strike_ix(&self.keeper.pubkey());
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])?;
        Ok(epoch)
    }

    /// Moves the clock past the live epoch's close.
    pub fn pass_close(&mut self) {
        let close = self.queue().current.close_ts;
        let now = self.now();
        if now < close {
            self.advance(1, close - now);
        }
    }

    /// The account that gets a record's rent back when it closes.
    fn rent_receiver(&self, epoch_id: u64) -> Option<Pk> {
        let address = self.record_address(epoch_id);
        if !self.exists(&address) {
            return None;
        }
        let record = self.record(epoch_id);
        (record.pending == 1).then_some(record.rent_payer)
    }

    pub fn claim_deposit_ix(
        &self,
        caller: &Address,
        owner: &Address,
        epoch_id: u64,
    ) -> Instruction {
        self.claim_deposit_ix_to(caller, owner, epoch_id, None)
    }

    /// `claim_deposit`, with another share account of the owner's for a parked request.
    pub fn claim_deposit_ix_to(
        &self,
        caller: &Address,
        owner: &Address,
        epoch_id: u64,
        owner_destination: Option<Pk>,
    ) -> Instruction {
        let request = self.deposit_request_address(epoch_id, owner);
        let parked =
            self.exists(&request) && self.read::<fade::state::DepositRequest>(&request).parked;
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ClaimDeposit {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    request: pk(request),
                    owner: pk(*owner),
                    record: (!parked).then(|| pk(self.record_address(epoch_id))),
                    owner_shares: pk(ata(owner, &self.a.share_mint)),
                    share_claims: pk(self.a.share_claims),
                    share_mint: pk(self.a.share_mint),
                    vault_authority: pk(self.a.vault_authority),
                    rent_receiver: if parked {
                        None
                    } else {
                        self.rent_receiver(epoch_id)
                    },
                    owner_destination,
                    token_program: pk(token::token_program_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ClaimDeposit {}.data(),
        }
    }

    pub fn claim_deposit(
        &mut self,
        owner: &Address,
        epoch_id: u64,
    ) -> Result<TransactionMetadata, Failure> {
        let ix = self.claim_deposit_ix(&self.keeper.pubkey(), owner, epoch_id);
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    /// `claim_withdraw` reading the chain at `at_epoch`. The entry record is
    /// passed when the request has not been claimed before and `at_epoch` differs.
    pub fn claim_withdraw_ix(
        &self,
        caller: &Address,
        owner: &Address,
        epoch_id: u64,
        at_epoch: u64,
    ) -> Instruction {
        let request_address = self.withdraw_request_address(epoch_id, owner);
        let request = self.read::<fade::state::WithdrawRequest>(&request_address);
        if request.parked {
            // Only the delivery is left: no record.
            return self.claim_withdraw_ix_with(
                caller,
                owner,
                &request_address,
                None,
                None,
                None,
                None,
                None,
            );
        }
        let first = request.r_entry == 0;
        let entry = (first && at_epoch != epoch_id).then(|| pk(self.record_address(epoch_id)));
        // The claim closes the at-record if this request is its last reader, and
        // the entry record likewise; the entry and at records are one when equal.
        let at_receiver = {
            let record = self.record(at_epoch);
            let chain = fade_math::shares::Chain {
                r: record.r_after,
                v: record.v_after,
            };
            let releases = chain.ended() || chain.splits() || (first && at_epoch == epoch_id);
            (releases && record.pending == 1).then_some(record.rent_payer)
        };
        let entry_receiver = entry.and_then(|_| self.rent_receiver(epoch_id));
        self.claim_withdraw_ix_with(
            caller,
            owner,
            &request_address,
            Some(pk(self.record_address(at_epoch))),
            entry,
            at_receiver,
            entry_receiver,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn claim_withdraw_ix_with(
        &self,
        caller: &Address,
        owner: &Address,
        request_address: &Address,
        at_record: Option<Pk>,
        entry: Option<Pk>,
        at_receiver: Option<Pk>,
        entry_receiver: Option<Pk>,
        owner_destination: Option<Pk>,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ClaimWithdraw {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    request: pk(*request_address),
                    owner: pk(*owner),
                    at_record,
                    entry_record: entry,
                    owner_usdc: pk(ata(owner, &self.a.usdc_mint)),
                    payable_usdc: pk(self.a.payable),
                    usdc_mint: pk(self.a.usdc_mint),
                    vault_authority: pk(self.a.vault_authority),
                    rent_receiver: at_receiver,
                    entry_rent_receiver: entry_receiver,
                    owner_destination,
                    token_program: pk(token::token_program_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ClaimWithdraw {}.data(),
        }
    }

    pub fn claim_withdraw(
        &mut self,
        owner: &Address,
        epoch_id: u64,
        at_epoch: u64,
    ) -> Result<TransactionMetadata, Failure> {
        let ix = self.claim_withdraw_ix(&self.keeper.pubkey(), owner, epoch_id, at_epoch);
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    /// A founding deposit struck and claimed: the vault holds `amount` and the
    /// user the shares. Returns the user.
    pub fn found(&mut self, amount: u64) -> User {
        let lp = self.user(amount);
        let epoch = self.deposit(&lp, amount).expect("founding deposit");
        self.pass_close();
        self.strike().expect("founding strike");
        self.claim_deposit(&lp.key(), epoch)
            .expect("founding claim");
        lp
    }
}

/// Arguments of an `open_ticket`.
pub struct OpenArgs {
    pub authority: Address,
    pub payer: Address,
    pub funder: Address,
    pub funder_usdc: Address,
    pub share_account: Address,
    pub beneficiary: Address,
    pub price: u64,
    pub payout_table: Vec<Outcome>,
    pub app_share_bps: u64,
    pub nonce: u64,
}

impl OpenArgs {
    pub fn direct(
        env: &Env,
        player: &User,
        price: u64,
        payout_table: &[Outcome],
        app_share_bps: u64,
    ) -> Self {
        OpenArgs {
            authority: player.key(),
            payer: player.key(),
            funder: player.key(),
            funder_usdc: player.usdc,
            share_account: player.usdc,
            beneficiary: player.usdc,
            price,
            payout_table: payout_table.to_vec(),
            app_share_bps,
            nonce: env.next_nonce(&player.key()),
        }
    }
}

/// Deterministic stand-in for a slot's hash.
pub fn slot_hash(slot: u64) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[b"slot", &slot.to_le_bytes()]).to_bytes()
}

/// The demo slot of the specification: 3.50 % declared, top multiplier 3.5×.
pub fn slot_classic() -> Vec<Outcome> {
    vec![
        Outcome {
            p: 100_000_000,
            m: 35_000,
        },
        Outcome {
            p: 150_000_000,
            m: 20_000,
        },
        Outcome {
            p: 200_000_000,
            m: 12_000,
        },
        Outcome {
            p: 75_000_000,
            m: 10_000,
        },
        Outcome {
            p: 475_000_000,
            m: 0,
        },
    ]
}

/// A coin flip at 1.96×: margin 200 bps.
pub fn coin_flip() -> Vec<Outcome> {
    vec![
        Outcome {
            p: 500_000_000,
            m: 19_600,
        },
        Outcome {
            p: 500_000_000,
            m: 0,
        },
    ]
}

pub trait ConfigExt {
    fn protocol_treasury_address(&self) -> Address;
}

impl ConfigExt for Config {
    fn protocol_treasury_address(&self) -> Address {
        addr(self.protocol_treasury)
    }
}
