//! Harness shared by the transaction-level tests: LiteSVM on the mainnet
//! feature set, Fade, the test integrator and the ORAO stand-in loaded at
//! ORAO's address, a USDC mint the tests control, a clock and a SlotHashes
//! sysvar the tests advance, and a builder for every instruction.
#![allow(dead_code, clippy::too_many_arguments)]

use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use fade::state::{
    Config, EpochRecord, Integrator, Outcome, Queue, RiskParams, Round, RoundTicket, Ticket, Vault,
};
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
#[derive(Clone, Copy)]
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

    /// `initialize`, then the council turns the beacon on (it starts paused),
    /// so every test starts with no pause set.
    pub fn with_params(params: RiskParams) -> Self {
        Self::ready(Self::bare(), params)
    }

    /// `new` on a cluster where `increase_tx_account_lock_limit` is active:
    /// a transaction may lock 128 accounts instead of 64.
    pub fn with_128_locks() -> Self {
        let svm =
            fade_testkit::litesvm_with_128_locks(fade_id(), &fade_testkit::program_path("fade"));
        Self::ready(Self::bare_on(svm), RiskParams::SPEC)
    }

    fn ready(mut env: Self, params: RiskParams) -> Self {
        env.initialize(params).expect("initialize");
        let council = env.council.insecure_clone();
        env.set_pause_flags(&council, 0, None)
            .expect("the council turns the beacon on");
        env
    }

    /// The programs and accounts, before `initialize`.
    pub fn bare() -> Self {
        Self::bare_on(fade_testkit::litesvm(
            fade_id(),
            &fade_testkit::program_path("fade"),
        ))
    }

    /// `bare` on `svm`, which holds the Fade program already.
    fn bare_on(mut svm: LiteSVM) -> Self {
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

    /// An independent copy of this environment, its accounts and keys
    /// included: what the state-machine test starts each case from, and
    /// where it settles one ticket alone to compare with its batch.
    pub fn fork(&self) -> Self {
        Env {
            svm: self.svm.clone(),
            a: self.a,
            deployer: self.deployer.insecure_clone(),
            council: self.council.insecure_clone(),
            guardian: self.guardian.insecure_clone(),
            treasury: self.treasury,
            orao_treasury: self.orao_treasury,
            keeper: self.keeper.insecure_clone(),
        }
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

    /// What anyone holding `address`'s key can do to it at any time: empty it
    /// (no account left), then deploy an upgradeable program at it
    /// (`solana program deploy --program-id`), the `toolchain_smoke` binary
    /// here. The address becomes executable, owned by the upgradeable loader.
    pub fn turn_into_program(&mut self, address: &Address) {
        self.svm.set_account(*address, Account::default()).unwrap();
        let elf = std::fs::read(fade_testkit::program_path("toolchain_smoke")).unwrap();
        self.svm.add_program(*address, &elf).unwrap();
        let acc = self.svm.get_account(address).unwrap();
        assert!(acc.executable);
        assert_eq!(acc.owner, upgradeable::loader_id());
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
        let ix = self.set_pause_flags_ix(&signer.pubkey(), flags, integrator);
        self.send(&[ix], &[signer])
    }

    pub fn set_pause_flags_ix(
        &self,
        signer: &Address,
        flags: u8,
        integrator: Option<(Address, bool)>,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SetPauseFlags {
                    authority: pk(*signer),
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
        }
    }

    // --- shared beacon ----------------------------------------------------------------

    /// `["payout-table", hash]`, the hash computed here independently of the
    /// program: `SHA256("FADE/PAYOUT-TABLE/v1" ‖ len ‖ p₀ ‖ m₀ ‖ …)`.
    pub fn payout_table_address(&self, outcomes: &[Outcome]) -> Address {
        fade_pda(&[fade::PAYOUT_TABLE_SEED, &payout_table_hash(outcomes)])
    }

    pub fn register_payout_table_ix(
        &self,
        payer: &Address,
        payout_table: &Address,
        outcomes: &[Outcome],
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RegisterPayoutTable {
                    payer: pk(*payer),
                    payout_table: pk(*payout_table),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::RegisterPayoutTable {
                outcomes: outcomes.to_vec(),
            }
            .data(),
        }
    }

    /// Registers `outcomes` at their own address, paid by `payer`.
    pub fn register_payout_table(
        &mut self,
        payer: &Keypair,
        outcomes: &[Outcome],
    ) -> Result<TransactionMetadata, Failure> {
        let table = self.payout_table_address(outcomes);
        let ix = self.register_payout_table_ix(&payer.pubkey(), &table, outcomes);
        self.send(&[ix], &[payer])
    }

    // --- rounds (Spec 08 §13.5.2) --------------------------------------------------------

    pub fn round(&self, id: u64) -> Round {
        self.read(&round_address(id))
    }
    pub fn round_ticket_address(&self, authority: &Address, nonce: u64) -> Address {
        let integrator = self.integrator_address(authority);
        fade_pda(&[
            fade::ROUND_TICKET_SEED,
            integrator.as_ref(),
            &nonce.to_le_bytes(),
        ])
    }
    pub fn round_ticket(&self, address: &Address) -> RoundTicket {
        self.read(address)
    }
    pub fn integrator(&self, authority: &Address) -> Integrator {
        self.read(&self.integrator_address(authority))
    }

    /// `D_r` a round created now snapshots: two ORAO fees, a pending
    /// request's rent at the test runtime's rent, the request share.
    pub fn draw_max(&self) -> u64 {
        fade_math::beacon::prefund(
            ORAO_FEE,
            self.svm
                .minimum_balance_for_rent_exemption(fade_math::orao_layout::PENDING_LEN),
            self.config().params.crank_request_lamports,
        )
        .unwrap()
    }

    /// The round a join sent now lands in, as the program resolves it.
    pub fn joining_round(&self) -> u64 {
        let v = self.vault();
        let a = v.accepting_round;
        if a != 0 && self.exists(&round_address(a)) {
            let acc = self.svm.get_account(&round_address(a)).unwrap();
            if acc.owner == fade_id() && self.round(a).accepts_joins(self.slot()) {
                return a;
            }
        }
        v.next_round_id
    }

    /// The pair a client passes: the accepting round it reads, or the next
    /// id if none, and its successor.
    pub fn round_pair(&self) -> (Address, Address) {
        let v = self.vault();
        let n = if v.accepting_round != 0 {
            v.accepting_round
        } else {
            v.next_round_id
        };
        (round_address(n), round_address(n + 1))
    }

    pub fn join_round_ix(&self, j: &JoinArgs) -> Instruction {
        let integrator = self.integrator_address(&j.authority);
        let ticket = self.round_ticket_address(&j.authority, j.nonce);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::JoinRound {
                    integrator_authority: pk(j.authority),
                    payer: pk(j.payer),
                    funder: pk(j.funder),
                    funder_usdc: pk(j.funder_usdc),
                    config: pk(self.a.config),
                    vault: pk(self.a.vault),
                    integrator: pk(integrator),
                    share_account: j.share_account.map(pk),
                    vault_usdc: pk(self.a.vault_usdc),
                    beneficiary: pk(j.beneficiary),
                    payout_table: pk(j.payout_table),
                    ticket: pk(ticket),
                    round: pk(j.round),
                    next_round: pk(j.next_round),
                    sponsorship_record: j.sponsorship_record.map(pk),
                    orao_network_state: pk(self.a.network_state),
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::JoinRound {
                price: j.price,
                app_share_bps: j.app_share_bps,
                nonce: j.nonce,
                sponsorship: j.sponsorship,
            }
            .data(),
        }
    }

    /// A player acting as its own integrator joins the round it reads, with
    /// the payout table registered at its hash.
    pub fn join(
        &mut self,
        player: &User,
        table: &[Outcome],
        price: u64,
        app_share_bps: u64,
        sponsorship: u64,
    ) -> Result<(Address, TransactionMetadata), Failure> {
        let j = JoinArgs::direct(self, player, table, price, app_share_bps, sponsorship);
        let ix = self.join_round_ix(&j);
        let kp = player.kp.insecure_clone();
        let meta = self.send(&[ix], &[&kp])?;
        Ok((self.round_ticket_address(&player.key(), j.nonce), meta))
    }

    /// Test-only: rewrites round `id` in place, and sets its lamports to
    /// `lamports` when given. Stands in for the instructions of later steps
    /// that move a round to `Requested`, `Drawn`, `Refunded` or `Forfeited`.
    pub fn set_round(&mut self, id: u64, lamports: Option<u64>, f: impl FnOnce(&mut Round)) {
        let address = round_address(id);
        let mut account = self.svm.get_account(&address).unwrap();
        let mut round = Round::try_deserialize(&mut account.data.as_slice()).unwrap();
        f(&mut round);
        let mut data = Vec::new();
        round.try_serialize(&mut data).unwrap();
        account.data[..data.len()].copy_from_slice(&data);
        if let Some(l) = lamports {
            account.lamports = l;
        }
        self.svm.set_account(address, account).unwrap();
    }

    pub fn sponsor_round_ix(
        &self,
        sponsor: &Address,
        record: &Address,
        round: &Address,
        lamports: u64,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SponsorRound {
                    sponsor: pk(*sponsor),
                    vault: pk(self.a.vault),
                    round: pk(*round),
                    sponsorship: pk(*record),
                    orao_network_state: pk(self.a.network_state),
                    config: pk(self.a.config),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::SponsorRound { lamports }.data(),
        }
    }

    /// `sponsor` sponsors round `id` with `lamports`, through its own record.
    pub fn sponsor(
        &mut self,
        sponsor: &Keypair,
        id: u64,
        lamports: u64,
    ) -> Result<TransactionMetadata, Failure> {
        let round = round_address(id);
        let record = sponsorship_address(&round, &sponsor.pubkey());
        let ix = self.sponsor_round_ix(&sponsor.pubkey(), &record, &round, lamports);
        self.send(&[ix], &[sponsor])
    }

    pub fn reclaim_ix(
        &self,
        caller: &Address,
        round: &Address,
        record: &Address,
        sponsor: &Address,
        rent_payer: Option<Address>,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ReclaimSponsorship {
                    caller: pk(*caller),
                    round: pk(*round),
                    sponsorship: pk(*record),
                    sponsor: pk(*sponsor),
                    rent_payer: rent_payer.map(pk),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ReclaimSponsorship {}.data(),
        }
    }

    /// The keeper reclaims `sponsor`'s sponsorship of round `id`, passing the
    /// round's rent payer.
    pub fn reclaim(&mut self, id: u64, sponsor: &Address) -> Result<TransactionMetadata, Failure> {
        let round = round_address(id);
        let rent_payer = addr(self.round(id).rent_payer);
        let record = sponsorship_address(&round, sponsor);
        let keeper = self.keeper.insecure_clone();
        let ix = self.reclaim_ix(&keeper.pubkey(), &round, &record, sponsor, Some(rent_payer));
        self.send(&[ix], &[&keeper])
    }

    // --- a round's draw (Spec 08 §13.5.6) -------------------------------------------------

    /// The entropy entry of round `id`'s seed in today's SlotHashes: the
    /// first slot after its close, with its hash.
    pub fn round_entropy(&self, id: u64) -> Option<fade_math::slot_hashes::Entry> {
        let close = self.round(id).close_slot;
        let data = self
            .svm
            .get_account(&addr(fade::SLOT_HASHES_ID))
            .unwrap()
            .data;
        fade_math::slot_hashes::first_after(&data, close)
    }

    /// Round `id`'s ORAO seed: the one recorded on the round, else the one it
    /// would get if requested now, byte by byte from Spec 08 §13.4 rather
    /// than through `fade_math`, so that the program's derivation is checked
    /// against the specification.
    pub fn round_seed(&self, id: u64) -> [u8; 32] {
        let r = self.round(id);
        if r.entropy_slot != 0 {
            return r.seed;
        }
        self.spec_seed(id)
    }

    /// Round `id`'s seed from today's SlotHashes, byte by byte from Spec 08
    /// §13.4, whatever the round recorded.
    pub fn spec_seed(&self, id: u64) -> [u8; 32] {
        let e = self.round_entropy(id).expect("entropy slot");
        let close = self.round(id).close_slot;
        let mut pre = b"FADE/BEACON-SEED/v1".to_vec();
        pre.extend_from_slice(fade_id().as_ref());
        pre.extend_from_slice(round_address(id).as_ref());
        pre.extend_from_slice(&close.to_le_bytes());
        pre.extend_from_slice(&e.slot.to_le_bytes());
        pre.extend_from_slice(&e.hash);
        assert_eq!(pre.len(), 131, "the seed preimage is 131 bytes");
        solana_sha256_hasher::hashv(&[&pre]).to_bytes()
    }

    /// ORAO's request address for round `id`'s seed, if requested now.
    pub fn round_request_address(&self, id: u64) -> Address {
        pda(
            &[orao_layout::REQUEST_SEED, &self.round_seed(id)],
            &orao_id(),
        )
    }

    pub fn request_round_draw_ix(
        &self,
        caller: &Address,
        id: u64,
        request: &Address,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RequestRoundDraw {
                    caller: pk(*caller),
                    round: pk(round_address(id)),
                    round_vrf: pk(round_vrf_address(id)),
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
            data: fade::instruction::RequestRoundDraw {}.data(),
        }
    }

    pub fn record_round_entropy_ix(&self, id: u64) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RecordRoundEntropy {
                    round: pk(round_address(id)),
                    slot_hashes: fade::SLOT_HASHES_ID,
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::RecordRoundEntropy {}.data(),
        }
    }

    /// The keeper records round `id`'s entropy now.
    pub fn record_round_entropy(&mut self, id: u64) -> Result<TransactionMetadata, Failure> {
        let keeper = self.keeper.insecure_clone();
        let ix = self.record_round_entropy_ix(id);
        self.send(&[ix], &[&keeper])
    }

    /// The keeper requests round `id`'s draw now; returns the request.
    pub fn request_round_draw(
        &mut self,
        id: u64,
    ) -> Result<(Address, TransactionMetadata), Failure> {
        let request = self.round_request_address(id);
        let keeper = self.keeper.insecure_clone();
        let ix = self.request_round_draw_ix(&keeper.pubkey(), id, &request);
        let meta = self.send(&[ix], &[&keeper])?;
        Ok((request, meta))
    }

    /// ORAO's quorum fulfils round `id`'s request with `randomness`; its
    /// refund of the pending rent goes to the request's client, `round_vrf`.
    pub fn fulfill_round(&mut self, id: u64, randomness: [u8; 64]) {
        let request = addr(self.round(id).randomness);
        self.fulfill(&request, randomness);
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

    /// The keeper expires `ticket`: the bound request once requested;
    /// otherwise the request address derived from its seed, recorded in the
    /// same transaction when it is not yet and the ticket is past its expiry
    /// slot (the keeper's bundle), or the System program when the seed can no
    /// longer be derived.
    pub fn expire(&mut self, ticket: &Address) -> Result<TransactionMetadata, Failure> {
        let w = self.ticket(ticket);
        let mut ixs = Vec::new();
        let randomness = if w.status == fade::state::TicketStatus::Requested {
            addr(w.randomness)
        } else {
            match self.ticket_request_address(ticket) {
                Some(request) => {
                    if !w.entropy_recorded() && self.slot() > w.expiry_slot {
                        ixs.push(self.record_ticket_entropy_ix(ticket));
                    }
                    request
                }
                None => system_id(),
            }
        };
        ixs.push(self.expire_ix(&self.keeper.pubkey(), ticket, &randomness));
        let keeper = self.keeper.insecure_clone();
        self.send(&ixs, &[&keeper])
    }

    /// ORAO's request address for an Open ticket: from its recorded seed,
    /// whatever SlotHashes holds, or from SlotHashes while it proves the
    /// entropy slot; `None` once neither can.
    pub fn ticket_request_address(&self, ticket: &Address) -> Option<Address> {
        let w = self.ticket(ticket);
        if w.entropy_recorded() {
            return Some(pda(&[orao_layout::REQUEST_SEED, &w.seed], &orao_id()));
        }
        let data = self
            .svm
            .get_account(&addr(fade::SLOT_HASHES_ID))
            .unwrap()
            .data;
        let e = fade_math::slot_hashes::first_after_retained(&data, w.open_slot)?;
        let seed = fade::instructions::request_randomness::orao_seed(
            &fade::ID,
            &pk(*ticket),
            w.open_slot,
            e.slot,
            &e.hash,
        );
        Some(pda(&[orao_layout::REQUEST_SEED, &seed], &orao_id()))
    }

    pub fn record_ticket_entropy_ix(&self, ticket: &Address) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RecordTicketEntropy {
                    ticket: pk(*ticket),
                    slot_hashes: fade::SLOT_HASHES_ID,
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::RecordTicketEntropy {}.data(),
        }
    }

    pub fn record_ticket_entropy(
        &mut self,
        ticket: &Address,
    ) -> Result<TransactionMetadata, Failure> {
        let ix = self.record_ticket_entropy_ix(ticket);
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    pub fn refund_expired_ix(&self, caller: &Address, ticket: &Address) -> Instruction {
        let w = self.ticket(ticket);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RefundExpiredTicket {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    vault: pk(self.a.vault),
                    integrator: w.integrator,
                    ticket: pk(*ticket),
                    vrf_payer: pk(self.vrf_payer(ticket)),
                    slot_hashes: fade::SLOT_HASHES_ID,
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
            data: fade::instruction::RefundExpiredTicket {}.data(),
        }
    }

    pub fn refund_expired(&mut self, ticket: &Address) -> Result<TransactionMetadata, Failure> {
        let ix = self.refund_expired_ix(&self.keeper.pubkey(), ticket);
        let keeper = self.keeper.insecure_clone();
        self.send(&[ix], &[&keeper])
    }

    /// `sweep_ticket_vrf(nonce)` for the integrator whose authority is
    /// `authority`, every account the derived one.
    pub fn sweep_ticket_vrf_ix(
        &self,
        caller: &Address,
        authority: &Address,
        nonce: u64,
    ) -> Instruction {
        let ticket = self.ticket_address(authority, nonce);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SweepTicketVrf {
                    caller: pk(*caller),
                    integrator: pk(self.integrator_address(authority)),
                    ticket: pk(ticket),
                    vrf_payer: pk(self.vrf_payer(&ticket)),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::SweepTicketVrf { nonce }.data(),
        }
    }

    /// Warps the clock far enough that SlotHashes no longer proves the
    /// entropy slot of anything opened before it.
    pub fn forget_slot_hashes(&mut self) {
        self.advance(600, 240);
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

/// Arguments of a `join_round`.
#[derive(Clone)]
pub struct JoinArgs {
    pub authority: Address,
    pub payer: Address,
    pub funder: Address,
    pub funder_usdc: Address,
    pub share_account: Option<Address>,
    pub beneficiary: Address,
    pub payout_table: Address,
    pub price: u64,
    pub app_share_bps: u64,
    pub nonce: u64,
    pub sponsorship: u64,
    pub round: Address,
    pub next_round: Address,
    pub sponsorship_record: Option<Address>,
}

impl JoinArgs {
    /// The player signs as integrator, payer and funder, and is its own
    /// beneficiary and share account; the rounds are the pair it reads, the
    /// sponsorship record the one of the round it expects to land in.
    pub fn direct(
        env: &Env,
        player: &User,
        table: &[Outcome],
        price: u64,
        app_share_bps: u64,
        sponsorship: u64,
    ) -> Self {
        let (round, next_round) = env.round_pair();
        let target = round_address(env.joining_round());
        JoinArgs {
            authority: player.key(),
            payer: player.key(),
            funder: player.key(),
            funder_usdc: player.usdc,
            share_account: Some(player.usdc),
            beneficiary: player.usdc,
            payout_table: env.payout_table_address(table),
            price,
            app_share_bps,
            nonce: env.next_nonce(&player.key()),
            sponsorship,
            round,
            next_round,
            sponsorship_record: (sponsorship > 0)
                .then(|| sponsorship_address(&target, &player.key())),
        }
    }
}

/// `["round", id]`.
pub fn round_address(id: u64) -> Address {
    fade_pda(&[fade::ROUND_SEED, &id.to_le_bytes()])
}

/// `["round-vrf", round]`, the system-owned PDA that pays ORAO for round `id`.
pub fn round_vrf_address(id: u64) -> Address {
    fade_pda(&[fade::ROUND_VRF_SEED, round_address(id).as_ref()])
}

/// `["sponsorship", round, sponsor]`, `round` the `Round` account's address.
pub fn sponsorship_address(round: &Address, sponsor: &Address) -> Address {
    fade_pda(&[fade::SPONSORSHIP_SEED, round.as_ref(), sponsor.as_ref()])
}

/// Every event of type `E` emitted through `emit_cpi!` in a transaction.
pub fn events<E: anchor_lang::Event>(meta: &TransactionMetadata) -> Vec<E> {
    let mut prefix = anchor_lang::event::EVENT_IX_TAG_LE.to_vec();
    prefix.extend_from_slice(E::DISCRIMINATOR);
    meta.inner_instructions
        .iter()
        .flatten()
        .filter_map(|ix| ix.instruction.data.strip_prefix(prefix.as_slice()))
        .map(|mut data| E::deserialize(&mut data).unwrap())
        .collect()
}

/// Deterministic stand-in for a slot's hash.
/// A payout table's hash, byte by byte from Spec 08 §13.2.1.
pub fn payout_table_hash(outcomes: &[Outcome]) -> [u8; 32] {
    let mut pre = b"FADE/PAYOUT-TABLE/v1".to_vec();
    pre.push(u8::try_from(outcomes.len()).expect("at most 255 outcomes"));
    for o in outcomes {
        pre.extend_from_slice(&o.p.to_le_bytes());
        pre.extend_from_slice(&o.m.to_le_bytes());
    }
    solana_sha256_hasher::hashv(&[&pre]).to_bytes()
}

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

/// 200× with probability 0.485 %: a 300 bps margin. At the beacon's minimum
/// price of 0.50 USDC on a 100 000 USDC vault it uses about 7 % of its cap,
/// within the `h · k` floor of the join that pays a round, and above the
/// 5.8 % share of a round its own price buys.
pub fn mid_shot() -> Vec<Outcome> {
    vec![
        Outcome {
            p: 4_850_000,
            m: 2_000_000,
        },
        Outcome {
            p: 1_000_000_000 - 4_850_000,
            m: 0,
        },
    ]
}

/// 160× with probability 0.60625 %: a 300 bps margin. On a 100 000 USDC
/// vault it uses about 97 % of the share of a round its own price buys, at
/// any price: within that share, and above the 90 % of it its price adds to
/// an unpaid round's room, so it fits an unpaid round only on room other
/// joins or sponsors bought.
pub fn near_share() -> Vec<Outcome> {
    vec![
        Outcome {
            p: 6_062_500,
            m: 1_600_000,
        },
        Outcome {
            p: 1_000_000_000 - 6_062_500,
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

// --- grouped settlement (Spec 08 §13.5.7, §13.5.11) ----------------------------------

/// One ticket's accounts in a `settle_round_tickets` batch, in the order of
/// the layout: `beneficiary` present exactly for a winner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub ticket: Address,
    pub integrator: Address,
    pub payer: Address,
    pub payout_table: Address,
    pub beneficiary: Option<Address>,
}

impl Group {
    /// The group's account metas: every account writable but the payout table.
    pub fn metas(&self) -> Vec<AccountMeta> {
        let mut v = vec![
            AccountMeta::new(self.ticket, false),
            AccountMeta::new(self.integrator, false),
            AccountMeta::new(self.payer, false),
            AccountMeta::new_readonly(self.payout_table, false),
        ];
        if let Some(b) = self.beneficiary {
            v.push(AccountMeta::new(b, false));
        }
        v
    }
}

/// `SHA256("FADE/BEACON-OUTCOME/v1" ‖ program ‖ round ‖ ticket ‖ R ‖ i)`,
/// byte by byte from Spec 08 §13.4 rather than through `fade_math` or the
/// program, so that the program's outcomes are checked against the
/// specification.
pub fn beacon_outcome_hash(round: &Address, ticket: &Address, r: &[u8; 64], i: u8) -> [u8; 32] {
    let mut pre = b"FADE/BEACON-OUTCOME/v1".to_vec();
    pre.extend_from_slice(fade_id().as_ref());
    pre.extend_from_slice(round.as_ref());
    pre.extend_from_slice(ticket.as_ref());
    pre.extend_from_slice(r);
    pre.push(i);
    assert_eq!(pre.len(), 183, "the outcome preimage is 183 bytes");
    solana_sha256_hasher::hashv(&[&pre]).to_bytes()
}

/// The compute-budget instruction raising the transaction's limit to `units`.
pub fn compute_limit_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: solana_sdk_ids::compute_budget::ID,
        accounts: vec![],
        data,
    }
}

/// The compute-budget instruction setting a priority fee, micro-lamports per unit.
pub fn compute_price_ix(micro_lamports: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id: solana_sdk_ids::compute_budget::ID,
        accounts: vec![],
        data,
    }
}

impl Env {
    /// The 64-byte randomness of round `id`'s fulfilled request.
    pub fn round_randomness(&self, id: u64) -> [u8; 64] {
        let request = addr(self.round(id).randomness);
        let data = self.svm.get_account(&request).unwrap().data;
        match orao_layout::randomness(&data) {
            Some(orao_layout::Randomness::Fulfilled { randomness, .. }) => randomness,
            other => panic!("round {id} is not fulfilled: {other:?}"),
        }
    }

    /// The payout table a beacon ticket references, read from its account.
    pub fn round_ticket_outcomes(&self, ticket: &Address) -> Vec<fade_math::payout_table::Outcome> {
        let t = self.round_ticket(ticket);
        let table: fade::state::PayoutTable = self.read(&addr(t.payout_table));
        table.outcomes()
    }

    /// The outcome `r` gives `ticket` of round `id`, computed independently.
    pub fn beacon_outcome_with(&self, id: u64, ticket: &Address, r: &[u8; 64]) -> usize {
        let outcomes = self.round_ticket_outcomes(ticket);
        let summary = fade_math::payout_table::validate(&outcomes).unwrap();
        let round = round_address(id);
        let draw = fade_math::select::draw(
            |k| beacon_outcome_hash(&round, ticket, r, k),
            fade::OUTCOME_ROUNDS,
        )
        .unwrap();
        fade_math::select::outcome(draw, &summary.cum, summary.len).unwrap()
    }

    /// The payout `r` gives `ticket` of round `id`.
    pub fn beacon_payout_with(&self, id: u64, ticket: &Address, r: &[u8; 64]) -> u64 {
        let outcomes = self.round_ticket_outcomes(ticket);
        let i = self.beacon_outcome_with(id, ticket, r);
        let t = self.round_ticket(ticket);
        fade_math::payout_table::payout(t.price, outcomes[i].m).unwrap()
    }

    /// The first randomness, in a fixed sequence, for which `pred` holds of
    /// the tickets' wins (`payout > 0`), in order.
    pub fn round_randomness_with(
        &self,
        id: u64,
        tickets: &[Address],
        pred: impl Fn(&[bool]) -> bool,
    ) -> [u8; 64] {
        for i in 0u64..1_000_000 {
            let mut r = [0u8; 64];
            r[..8].copy_from_slice(&i.to_le_bytes());
            r[63] = 7;
            let wins: Vec<bool> = tickets
                .iter()
                .map(|t| self.beacon_payout_with(id, t, &r) > 0)
                .collect();
            if pred(&wins) {
                return r;
            }
        }
        panic!("no randomness found");
    }

    /// Ticket `ticket`'s group in a batch of round `id`, its beneficiary
    /// present exactly when the round's randomness makes it win.
    pub fn round_group(&self, id: u64, ticket: &Address) -> Group {
        let r = self.round_randomness(id);
        self.round_group_with(id, ticket, &r)
    }

    /// `round_group` with the round's randomness `r` given.
    pub fn round_group_with(&self, id: u64, ticket: &Address, r: &[u8; 64]) -> Group {
        let t = self.round_ticket(ticket);
        let won = self.beacon_payout_with(id, ticket, r) > 0;
        Group {
            ticket: *ticket,
            integrator: addr(t.integrator),
            payer: addr(t.payer),
            payout_table: addr(t.payout_table),
            beneficiary: won.then(|| addr(t.beneficiary)),
        }
    }

    /// `settle_round_tickets(count, wins)` with these remaining accounts.
    pub fn settle_round_raw_ix(
        &self,
        caller: &Address,
        id: u64,
        count: u8,
        wins: u32,
        remaining: Vec<AccountMeta>,
        rent_payer: Option<Address>,
    ) -> Instruction {
        let round = self.round(id);
        let mut accounts = metas(
            fade::accounts::SettleRoundTickets {
                caller: pk(*caller),
                config: pk(self.a.config),
                vault: pk(self.a.vault),
                round: pk(round_address(id)),
                round_vrf: pk(round_vrf_address(id)),
                randomness: round.randomness,
                payout_escrow: pk(self.a.payout_escrow),
                vault_usdc: pk(self.a.vault_usdc),
                vault_authority: pk(self.a.vault_authority),
                usdc_mint: pk(self.a.usdc_mint),
                token_program: pk(token::token_program_id()),
                system_program: pk(system_id()),
                rent_payer: rent_payer.map(pk),
                event_authority: pk(self.a.event_authority),
                program: fade::ID,
            }
            .to_account_metas(None),
        );
        accounts.extend(remaining);
        Instruction {
            program_id: fade_id(),
            accounts,
            data: fade::instruction::SettleRoundTickets { count, wins }.data(),
        }
    }

    /// A batch settling `groups`, `wins` set from which carry a beneficiary.
    pub fn settle_round_ix(
        &self,
        caller: &Address,
        id: u64,
        groups: &[Group],
        rent_payer: Option<Address>,
    ) -> Instruction {
        let mut wins = 0u32;
        let mut remaining = Vec::new();
        for (i, g) in groups.iter().enumerate() {
            if g.beneficiary.is_some() {
                wins |= 1 << i;
            }
            remaining.extend(g.metas());
        }
        let count = u8::try_from(groups.len()).unwrap();
        self.settle_round_raw_ix(caller, id, count, wins, remaining, rent_payer)
    }

    /// The keeper settles `tickets` of round `id` in one batch, passing the
    /// round's rent payer, with the compute limit at its maximum.
    pub fn settle_round(
        &mut self,
        id: u64,
        tickets: &[Address],
    ) -> Result<TransactionMetadata, Failure> {
        let groups: Vec<Group> = tickets.iter().map(|t| self.round_group(id, t)).collect();
        let keeper = self.keeper.insecure_clone();
        let rent_payer = addr(self.round(id).rent_payer);
        let ix = self.settle_round_ix(&keeper.pubkey(), id, &groups, Some(rent_payer));
        self.send_v0(&[compute_limit_ix(1_400_000), ix], &[&keeper], &[])
    }

    /// Sends a version-0 transaction resolving `tables` (address lookup
    /// tables written with `lookup_table`).
    pub fn send_v0(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        tables: &[solana_message::AddressLookupTableAccount],
    ) -> Result<TransactionMetadata, Failure> {
        let tx = self.v0_transaction(ixs, signers, tables);
        self.send_versioned(tx)
    }

    pub fn send_versioned(
        &mut self,
        tx: solana_transaction::versioned::VersionedTransaction,
    ) -> Result<TransactionMetadata, Failure> {
        let result = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        result.map_err(|e| Failure {
            err: format!("{:?}", e.err),
            logs: e.meta.logs,
        })
    }

    pub fn v0_transaction(
        &self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        tables: &[solana_message::AddressLookupTableAccount],
    ) -> solana_transaction::versioned::VersionedTransaction {
        let message = solana_message::v0::Message::try_compile(
            &signers[0].pubkey(),
            ixs,
            tables,
            self.svm.latest_blockhash(),
        )
        .unwrap();
        solana_transaction::versioned::VersionedTransaction::try_new(
            solana_message::VersionedMessage::V0(message),
            signers,
        )
        .unwrap()
    }

    /// Writes an active address lookup table holding `addresses`.
    pub fn lookup_table(
        &mut self,
        addresses: &[Address],
    ) -> solana_message::AddressLookupTableAccount {
        use solana_address_lookup_table_interface::state::{AddressLookupTable, LookupTableMeta};
        let key = Address::new_unique();
        let table = AddressLookupTable {
            meta: LookupTableMeta::new(self.keeper.pubkey()),
            addresses: std::borrow::Cow::Owned(addresses.to_vec()),
        };
        let data = table.serialize_for_tests().unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                key,
                Account {
                    lamports,
                    data,
                    owner: solana_sdk_ids::address_lookup_table::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        solana_message::AddressLookupTableAccount {
            key,
            addresses: addresses.to_vec(),
        }
    }

    pub fn claim_round_payout_ix(
        &self,
        caller: &Address,
        ticket: &Address,
        destination: &Address,
    ) -> Instruction {
        let t = self.round_ticket(ticket);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ClaimRoundPayout {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    ticket: pk(*ticket),
                    destination: pk(*destination),
                    payout_escrow: pk(self.a.payout_escrow),
                    vault_authority: pk(self.a.vault_authority),
                    payer: t.payer,
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ClaimRoundPayout {}.data(),
        }
    }

    /// The keeper delivers a parked beacon payout to its beneficiary.
    pub fn claim_round_payout(&mut self, ticket: &Address) -> Result<TransactionMetadata, Failure> {
        let t = self.round_ticket(ticket);
        let destination = match t.status {
            fade::state::RoundTicketStatus::ReturnParked => addr(t.refund_to),
            _ => addr(t.beneficiary),
        };
        let keeper = self.keeper.insecure_clone();
        let ix = self.claim_round_payout_ix(&keeper.pubkey(), ticket, &destination);
        self.send(&[ix], &[&keeper])
    }

    // --- the ends of a round that never drew (Spec 08 §13.5.5, §13.5.8, §13.5.9) ---------

    /// Sets the fee in the stand-in for ORAO's network state (after the
    /// discriminator, the authority and the treasury).
    pub fn set_orao_fee(&mut self, fee: u64) {
        let mut ns = self.svm.get_account(&self.a.network_state).unwrap();
        ns.data[72..80].copy_from_slice(&fee.to_le_bytes());
        self.svm.set_account(self.a.network_state, ns).unwrap();
    }

    /// `refund_round` of round `id` by `caller`, who shows `participant`
    /// (a `RoundTicket` of the round) as its part in it.
    pub fn refund_round_ix(&self, caller: &Address, id: u64, participant: &Address) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::RefundRound {
                    caller: pk(*caller),
                    vault: pk(self.a.vault),
                    round: pk(round_address(id)),
                    participant: pk(*participant),
                    orao_network_state: pk(self.a.network_state),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::RefundRound {}.data(),
        }
    }

    /// `caller` refunds round `id`, showing `participant`; the keeper pays the fee.
    pub fn refund_round(
        &mut self,
        caller: &Keypair,
        id: u64,
        participant: &Address,
    ) -> Result<TransactionMetadata, Failure> {
        let keeper = self.keeper.insecure_clone();
        let ix = self.refund_round_ix(&caller.pubkey(), id, participant);
        self.send(&[ix], &[&keeper, caller])
    }

    /// `expire_round` for round `id`, naming `randomness` as its request.
    pub fn expire_round_ix(&self, caller: &Address, id: u64, randomness: &Address) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ExpireRound {
                    caller: pk(*caller),
                    vault: pk(self.a.vault),
                    round: pk(round_address(id)),
                    round_vrf: pk(round_vrf_address(id)),
                    randomness: pk(*randomness),
                    slot_hashes: fade::SLOT_HASHES_ID,
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ExpireRound {}.data(),
        }
    }

    /// The request `expire_round` names for round `id`: the stored one once
    /// requested; otherwise ORAO's request address for the round's seed,
    /// recorded or while SlotHashes still proves its entropy slot, any
    /// account when neither.
    pub fn expiry_request(&self, id: u64) -> Address {
        let r = self.round(id);
        if r.status != fade::state::RoundStatus::Paid {
            return addr(r.randomness);
        }
        if r.entropy_slot != 0 {
            return self.round_request_address(id);
        }
        let data = self
            .svm
            .get_account(&addr(fade::SLOT_HASHES_ID))
            .unwrap()
            .data;
        match fade_math::slot_hashes::first_after_retained(&data, r.close_slot) {
            Some(_) => self.round_request_address(id),
            None => addr(r.randomness),
        }
    }

    /// The keeper expires round `id`, naming the request `expiry_request` gives.
    pub fn expire_round(&mut self, id: u64) -> Result<TransactionMetadata, Failure> {
        let keeper = self.keeper.insecure_clone();
        let randomness = self.expiry_request(id);
        let ix = self.expire_round_ix(&keeper.pubkey(), id, &randomness);
        self.send(&[ix], &[&keeper])
    }

    /// `sweep_round_vrf(id)`, every account the derived one.
    pub fn sweep_round_vrf_ix(&self, caller: &Address, id: u64) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::SweepRoundVrf {
                    caller: pk(*caller),
                    vault: pk(self.a.vault),
                    round: pk(round_address(id)),
                    round_vrf: pk(round_vrf_address(id)),
                    system_program: pk(system_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::SweepRoundVrf { round_id: id }.data(),
        }
    }

    /// `return_round_ticket` for `ticket`, every account the stored one.
    pub fn return_round_ticket_ix(
        &self,
        caller: &Address,
        ticket: &Address,
        rent_payer: Option<Address>,
    ) -> Instruction {
        let t = self.round_ticket(ticket);
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ReturnRoundTicket {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    vault: pk(self.a.vault),
                    round: pk(round_address(t.round)),
                    integrator: t.integrator,
                    ticket: pk(*ticket),
                    payer: t.payer,
                    refund_to: t.refund_to,
                    payout_escrow: pk(self.a.payout_escrow),
                    vault_usdc: pk(self.a.vault_usdc),
                    vault_authority: pk(self.a.vault_authority),
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    rent_payer: rent_payer.map(pk),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ReturnRoundTicket {}.data(),
        }
    }

    /// The keeper returns `ticket`, passing its round's rent payer.
    pub fn return_round_ticket(
        &mut self,
        ticket: &Address,
    ) -> Result<TransactionMetadata, Failure> {
        let t = self.round_ticket(ticket);
        let rent_payer = addr(self.round(t.round).rent_payer);
        let keeper = self.keeper.insecure_clone();
        let ix = self.return_round_ticket_ix(&keeper.pubkey(), ticket, Some(rent_payer));
        self.send(&[ix], &[&keeper])
    }

    /// Test-only: rewrites a beacon ticket in place.
    pub fn set_round_ticket(&mut self, address: &Address, f: impl FnOnce(&mut RoundTicket)) {
        let mut account = self.svm.get_account(address).unwrap();
        let mut t = RoundTicket::try_deserialize(&mut account.data.as_slice()).unwrap();
        f(&mut t);
        let mut data = Vec::new();
        t.try_serialize(&mut data).unwrap();
        account.data[..data.len()].copy_from_slice(&data);
        self.svm.set_account(*address, account).unwrap();
    }

    /// `claim_shares` to `destination`: the protocol's shares without
    /// `integrator`, the app shares of the record at `integrator` with it.
    pub fn claim_shares_ix(
        &self,
        caller: &Address,
        integrator: Option<Address>,
        destination: &Address,
    ) -> Instruction {
        Instruction {
            program_id: fade_id(),
            accounts: metas(
                fade::accounts::ClaimShares {
                    caller: pk(*caller),
                    config: pk(self.a.config),
                    vault: pk(self.a.vault),
                    integrator: integrator.map(pk),
                    destination: pk(*destination),
                    vault_usdc: pk(self.a.vault_usdc),
                    vault_authority: pk(self.a.vault_authority),
                    usdc_mint: pk(self.a.usdc_mint),
                    token_program: pk(token::token_program_id()),
                    event_authority: pk(self.a.event_authority),
                    program: fade::ID,
                }
                .to_account_metas(None),
            ),
            data: fade::instruction::ClaimShares {}.data(),
        }
    }

    /// The keeper claims the protocol's shares (`None`) or those of the
    /// integrator whose authority is given, to the stored destination.
    pub fn claim_shares(
        &mut self,
        authority: Option<&Address>,
    ) -> Result<TransactionMetadata, Failure> {
        let (integrator, destination) = match authority {
            Some(a) => (
                Some(self.integrator_address(a)),
                addr(self.integrator(a).share_account),
            ),
            None => (None, addr(self.config().protocol_treasury)),
        };
        let keeper = self.keeper.insecure_clone();
        let ix = self.claim_shares_ix(&keeper.pubkey(), integrator, &destination);
        self.send(&[ix], &[&keeper])
    }
}
