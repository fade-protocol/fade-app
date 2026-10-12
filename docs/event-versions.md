# Event schema versions

Every event carries `version: u8` as its first field (see `programs/fade/src/events.rs`).
`events.lock.json` pins each event's field list and version; `pnpm events:check` fails
when one changes without the other. A row is added here whenever a version moves.

| Event | Version | Since | What changed |
|---|---|---|---|
| `Initialized` | 1 | V1 program | First version |
| `ParamsChanged` | 1 | V1 program | First version |
| `ParamsApplied` | 1 | V1 program | First version |
| `ParamsCancelled` | 1 | V1 program | First version |
| `PauseFlagsChanged` | 1 | V1 program | First version |
| `ShareMetadataSet` | 1 | V1 program | First version: `set_share_metadata` named the share mint for wallets |
| `IntegratorCreated` | 1 | V1 program | First version |
| `ShareAccountChanged` | 1 | V1 program | First version |
| `TicketOpened` | 1 | V1 program | First version |
| `RandomnessRequested` | 1 | V1 program | First version |
| `TicketSettled` | 1 | V1 program | First version |
| `TicketExpired` | 1 | V1 program | First version |
| `PayoutClaimed` | 1 | V1 program | First version |
| `DepositRequested` | 1 | V1 program | First version |
| `WithdrawRequested` | 1 | V1 program | First version |
| `EpochStruck` | 1 | V1 program | First version |
| `DepositClaimed` | 1 | V1 program | First version |
| `WithdrawClaimed` | 1 | V1 program | First version |
| `ClaimDelivered` | 1 | V1 program | First version |

**Retired before any deployment**, kept in the lock so their names are never reused with another layout: `IntegratorRegistered`, `BondChanged`: the integrator registration and bond of Phase 2, removed with the bond.
