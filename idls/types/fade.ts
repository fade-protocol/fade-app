/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fade.json`.
 */
export type Fade = {
  "address": "HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL",
  "metadata": {
    "name": "fade",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Fade — a permissionless payout protocol for Solana",
    "repository": "https://github.com/fade-protocol/fade-app"
  },
  "instructions": [
    {
      "name": "applyParams",
      "docs": [
        "Anyone, once the pending change is due."
      ],
      "discriminator": [
        188,
        203,
        86,
        124,
        178,
        34,
        133,
        116
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "cancelParams",
      "docs": [
        "Council only."
      ],
      "discriminator": [
        100,
        172,
        113,
        60,
        25,
        68,
        80,
        172
      ],
      "accounts": [
        {
          "name": "council",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "claimDeposit",
      "docs": [
        "Anyone: the request's own `CLAIM_FEE` pays whoever claims it."
      ],
      "discriminator": [
        201,
        106,
        1,
        224,
        122,
        144,
        210,
        155
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "request",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "request.epochId",
                "account": "depositRequest"
              },
              {
                "kind": "account",
                "path": "request.owner",
                "account": "depositRequest"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "relations": [
            "request"
          ]
        },
        {
          "name": "record",
          "docs": [
            "Exists only once the request's epoch has been struck; absent once the",
            "request is parked."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "request.epochId",
                "account": "depositRequest"
              }
            ]
          }
        },
        {
          "name": "ownerShares",
          "docs": [
            "handler delivers to it only if it can receive."
          ],
          "writable": true
        },
        {
          "name": "shareClaims",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  45,
                  99,
                  108,
                  97,
                  105,
                  109,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "rentReceiver",
          "writable": true,
          "optional": true
        },
        {
          "name": "ownerDestination",
          "docs": [
            "another share account of the owner's, checked to be able to receive."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "claimPayout",
      "docs": [
        "Anyone: delivers a payout parked at settlement or at a refund."
      ],
      "discriminator": [
        127,
        240,
        132,
        62,
        227,
        198,
        146,
        133
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "beneficiary",
          "docs": [
            "The beneficiary stored at open — the only destination."
          ],
          "writable": true
        },
        {
          "name": "payoutEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "claimRoundPayout",
      "docs": [
        "Anyone, never paused: delivers a beacon ticket's payout or return",
        "parked in `payout_escrow`, and closes the ticket to its payer."
      ],
      "discriminator": [
        168,
        118,
        169,
        54,
        90,
        148,
        148,
        169
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "ticket",
          "docs": [
            "A parked beacon ticket, at `[\"round-ticket\", integrator, nonce]` with",
            "its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  45,
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "roundTicket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "roundTicket"
              }
            ]
          }
        },
        {
          "name": "destination",
          "docs": [
            "The only destination: `ticket.beneficiary` for a parked payout,",
            "`ticket.refund_to` for a parked return (`BeneficiaryMismatch`)."
          ],
          "writable": true
        },
        {
          "name": "payoutEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "ticket holds, its rent and what it kept for it at settlement."
          ],
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "claimShares",
      "docs": [
        "Anyone, never paused: the protocol's beacon shares to the treasury, or,",
        "with `integrator`, its app shares to its share account; the whole",
        "claimable ledger, which a destination unable to receive keeps."
      ],
      "discriminator": [
        130,
        131,
        29,
        237,
        134,
        20,
        110,
        245
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; nobody is paid to claim."
          ],
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "docs": [
            "The integrator whose app shares are claimed, at",
            "`[\"integrator\", authority]` with its stored bump; absent for the",
            "protocol's shares."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  103,
                  114,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "integrator.authority",
                "account": "integrator"
              }
            ]
          }
        },
        {
          "name": "destination",
          "docs": [
            "(`TreasuryMismatch`), `integrator.share_account` with it",
            "(`ShareAccountMismatch`); inspected before the transfer, which is",
            "made only if it can receive (`DestinationUnusable`)."
          ],
          "writable": true
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "claimWithdraw",
      "discriminator": [
        232,
        89,
        154,
        117,
        16,
        204,
        182,
        224
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "request",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  116,
                  104,
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "request.epochId",
                "account": "withdrawRequest"
              },
              {
                "kind": "account",
                "path": "request.owner",
                "account": "withdrawRequest"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "relations": [
            "request"
          ]
        },
        {
          "name": "atRecord",
          "docs": [
            "The record the chain is read at: the request's own epoch or a later one",
            "of the same chain. The final claim reads the one that ends the chain; a",
            "record where the chain splits carries the request into the next chain.",
            "Absent once the request is parked."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "atRecord.epochId",
                "account": "epochRecord"
              }
            ]
          }
        },
        {
          "name": "entryRecord",
          "docs": [
            "The request's own record, when it is not `at_record` and this is the",
            "request's first claim: it holds the chain indices at entry."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "request.epochId",
                "account": "withdrawRequest"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "docs": [
            "handler delivers to it only if it can receive."
          ],
          "writable": true
        },
        {
          "name": "payableUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  97,
                  98,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "rentReceiver",
          "writable": true,
          "optional": true
        },
        {
          "name": "entryRentReceiver",
          "writable": true,
          "optional": true
        },
        {
          "name": "ownerDestination",
          "docs": [
            "another USDC account of the owner's, checked to be able to receive."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "expireRound",
      "docs": [
        "Anyone, never paused, once `T_SETTLE` has passed since the close of a",
        "paid round whose draw was never requested, or never fulfilled: the",
        "round forfeits as a whole and leaves the epoch counters. Its tickets'",
        "credits stay with the vault; each ticket's payer gets back its prepay",
        "less its charge through `return_round_ticket`. A round never requested",
        "whose entropy was never recorded and is no longer proven by SlotHashes",
        "is refunded instead: whether its request exists, fulfilled, can no",
        "longer be checked."
      ],
      "discriminator": [
        238,
        222,
        71,
        141,
        104,
        222,
        76,
        248
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; unpaid itself, each forfeited ticket's return pays its",
            "settlement share."
          ],
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "The round, at `[\"round\", id]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "roundVrf",
          "docs": [
            "`[\"round-vrf\", round]` with the round's stored bump: holds what ORAO",
            "gave back and anything sent to it since the request; drained to the",
            "round when the round was requested."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  45,
                  118,
                  114,
                  102
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "randomness",
          "docs": [
            "requested; when it was not, ORAO's request address for the round's",
            "seed, recorded or proven by SlotHashes; any account when neither (the",
            "round is then refunded, nothing read). Address, owner and state",
            "checked in the handler."
          ]
        },
        {
          "name": "slotHashes",
          "docs": [
            "round never requested whose seed is not recorded."
          ],
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "expireTicket",
      "docs": [
        "Anyone, after `T_SETTLE`, if the randomness never arrived: forfeiture.",
        "Refused while a request at the ticket's seed is fulfilled, bound or",
        "not; a ticket never requested needs its seed recorded first."
      ],
      "discriminator": [
        157,
        15,
        116,
        148,
        212,
        48,
        57,
        121
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "writable": true
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "vrfPayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  114,
                  102,
                  45,
                  112,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "randomness",
          "docs": [
            "request address derived from its recorded seed; checked in the handler."
          ]
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "One-time setup by the program's upgrade authority; seeds the strike fund.",
        "The beacon starts paused (`PAUSE_ROUNDS`): the council turns it on."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Must be the program's upgrade authority: the one party that could",
            "already do anything, so no new trust is created. Pays every rent and",
            "seeds the strike fund."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "fadeProgram",
          "address": "HeuXg1Fn2R7TzzATextZjwySFq1m4YBgUdvXqbQuojsL"
        },
        {
          "name": "programData"
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "queue",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "`Account<Mint>` of the legacy token module: a Token-2022 mint fails the owner check."
          ],
          "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "payoutEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "depositQueueUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116,
                  45,
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "payableUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  97,
                  98,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "shareEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "shareClaims",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  45,
                  99,
                  108,
                  97,
                  105,
                  109,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "protocolTreasury",
          "docs": [
            "Where the protocol share goes. Any USDC token account; its owner is the council's business."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "council",
          "type": "pubkey"
        },
        {
          "name": "guardian",
          "type": "pubkey"
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "riskParams"
            }
          }
        }
      ]
    },
    {
      "name": "joinRound",
      "docs": [
        "Signed by the integrator and the funder, as `open_ticket`: a beacon",
        "ticket admitted on entry into the round accepting tickets, or into the",
        "next round, which the join then creates. `sponsorship` lamports from",
        "the payer go to the round's draw with it; 0 for none."
      ],
      "discriminator": [
        191,
        222,
        86,
        25,
        234,
        174,
        157,
        249
      ],
      "accounts": [
        {
          "name": "integratorAuthority",
          "docs": [
            "The integrator's identity, as in `open_ticket` (Spec 07 §2)."
          ],
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays the ticket's rent, the draw prepay, the settlement share, the",
            "sponsorship and, if this join creates them, the round's and the",
            "sponsorship record's rent. Gets back what is not spent."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "funder",
          "docs": [
            "Owns `funder_usdc` and signs for the ticket price."
          ],
          "signer": true
        },
        {
          "name": "funderUsdc",
          "docs": [
            "Where the ticket price comes from; stored as `refund_to`."
          ],
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "docs": [
            "Created by the integrator's first ticket on either path; never closed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  103,
                  114,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "integratorAuthority"
              }
            ]
          }
        },
        {
          "name": "shareAccount",
          "docs": [
            "then checked in the handler as a usable USDC account and stored. No",
            "share is paid at the join, so it is not read otherwise."
          ],
          "optional": true
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "beneficiary",
          "docs": [
            "Any legacy-SPL USDC account; stored, and the only place a payout can go."
          ]
        },
        {
          "name": "payoutTable",
          "docs": [
            "Owner and discriminator checked by Anchor; its address against its",
            "stored hash in the handler (`WrongPayoutTable`), in the check order."
          ]
        },
        {
          "name": "ticket",
          "docs": [
            "Never `init_if_needed`: the address is nonce-scoped and one-shot."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  45,
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "integrator"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "round and the round this join creates, if any (round resolution)."
          ],
          "writable": true
        },
        {
          "name": "nextRound",
          "writable": true
        },
        {
          "name": "sponsorshipRecord",
          "docs": [
            "`sponsorship > 0`; matched against the derived address in the handler,",
            "created or topped up there."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "oraoNetworkState",
          "docs": [
            "id; read, owner checked, on every join: its fee sets a created round's",
            "prefund and must still fit the target round's."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  111,
                  45,
                  118,
                  114,
                  102,
                  45,
                  110,
                  101,
                  116,
                  119,
                  111,
                  114,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  117,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                7,
                71,
                177,
                26,
                250,
                145,
                180,
                209,
                249,
                34,
                242,
                123,
                14,
                186,
                193,
                218,
                178,
                59,
                33,
                41,
                164,
                190,
                243,
                79,
                50,
                164,
                123,
                88,
                245,
                206,
                252,
                120
              ]
            }
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "appShareBps",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "sponsorship",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openTicket",
      "docs": [
        "Signed by the integrator — a program over CPI with its `[\"fade-integrator\"]`",
        "PDA, or a server or wallet — and by the funder."
      ],
      "discriminator": [
        154,
        120,
        166,
        69,
        155,
        111,
        27,
        207
      ],
      "accounts": [
        {
          "name": "integratorAuthority",
          "docs": [
            "The integrator's identity: a program signs with its `[\"fade-integrator\"]`",
            "PDA through `invoke_signed`, a server or a wallet with its own key."
          ],
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays the ticket's rent, the oracle prefund and the crank fee; receives",
            "every refund when the ticket closes."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "funder",
          "docs": [
            "Owns `funder_usdc`, pays the ticket price, and signs this very instruction: the",
            "user, or an app paying from funds it holds for its users or its own budget."
          ],
          "signer": true
        },
        {
          "name": "funderUsdc",
          "writable": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "docs": [
            "Created by the integrator's first ticket; never re-initialised, never closed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  103,
                  114,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "integratorAuthority"
              }
            ]
          }
        },
        {
          "name": "shareAccount",
          "docs": [
            "that it may be the funder's own USDC account — a user acting as its own",
            "integrator. Stored by the first ticket, and must equal the stored one after."
          ],
          "writable": true
        },
        {
          "name": "protocolTreasury",
          "writable": true
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "beneficiary",
          "docs": [
            "Any legacy-SPL USDC account; stored, and the only place a payout can go."
          ]
        },
        {
          "name": "ticket",
          "docs": [
            "Never `init_if_needed`: the address is nonce-scoped and one-shot."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "integrator"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "vrfPayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  114,
                  102,
                  45,
                  112,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "oraoNetworkState",
          "docs": [
            "owner checked in the handler; the fee is read from it, never set by Fade."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  111,
                  45,
                  118,
                  114,
                  102,
                  45,
                  110,
                  101,
                  116,
                  119,
                  111,
                  114,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  117,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                7,
                71,
                177,
                26,
                250,
                145,
                180,
                209,
                249,
                34,
                242,
                123,
                14,
                186,
                193,
                218,
                178,
                59,
                33,
                41,
                164,
                190,
                243,
                79,
                50,
                164,
                123,
                88,
                245,
                206,
                252,
                120
              ]
            }
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "payoutTable",
          "type": {
            "vec": {
              "defined": {
                "name": "outcome"
              }
            }
          }
        },
        {
          "name": "appShareBps",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "reclaimSponsorship",
      "docs": [
        "Anyone, never paused, once the round is drawn, forfeited or refunded:",
        "the sponsor's return and the record's rent to the sponsor."
      ],
      "discriminator": [
        12,
        191,
        46,
        60,
        198,
        100,
        209,
        198
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone: the return goes to the sponsor whoever sends it."
          ],
          "signer": true
        },
        {
          "name": "round",
          "docs": [
            "The round, at `[\"round\", id]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "sponsorship",
          "docs": [
            "The record, at `[\"sponsorship\", round, sponsor]` with its stored bump,",
            "of this round; closed here, its rent to the sponsor."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  112,
                  111,
                  110,
                  115,
                  111,
                  114,
                  115,
                  104,
                  105,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "round"
              },
              {
                "kind": "account",
                "path": "sponsor"
              }
            ]
          }
        },
        {
          "name": "sponsor",
          "docs": [
            "and the record's lamports."
          ],
          "writable": true,
          "relations": [
            "sponsorship"
          ]
        },
        {
          "name": "rentPayer",
          "docs": [
            "no sponsorship, and then must be `round.rent_payer`",
            "(`RentReceiverRequired`); not read otherwise."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "recordRoundEntropy",
      "docs": [
        "Anyone, never paused, unpaid: records a paid round's seed and entropy",
        "slot while SlotHashes proves them (from two slots after its close, for",
        "about 512 slots), so that finding its ORAO request never depends on",
        "the sysvar again. Succeeds without writing on a round already recorded."
      ],
      "discriminator": [
        10,
        224,
        194,
        91,
        123,
        242,
        42,
        154
      ],
      "accounts": [
        {
          "name": "round",
          "docs": [
            "The round, at `[\"round\", id]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "recordTicketEntropy",
      "docs": [
        "Anyone, never paused, unpaid: records an Open ticket's seed and",
        "entropy slot while SlotHashes proves them (from two slots after its",
        "open, for about 512 slots), so that finding its ORAO request never",
        "depends on the sysvar again. Succeeds without writing on a ticket",
        "already recorded."
      ],
      "discriminator": [
        69,
        13,
        51,
        142,
        153,
        3,
        89,
        129
      ],
      "accounts": [
        {
          "name": "ticket",
          "docs": [
            "The ticket, at `[\"ticket\", integrator, nonce]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "refundExpiredTicket",
      "docs": [
        "Anyone, never paused, paid the settler's share, after `T_SETTLE`: an",
        "Open ticket whose seed was never recorded and whose entropy slot",
        "SlotHashes no longer proves gets its vault credit back, since whether",
        "its request exists, fulfilled, can no longer be checked."
      ],
      "discriminator": [
        121,
        166,
        177,
        230,
        43,
        117,
        142,
        237
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; receives the settler's share of the crank fee."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "writable": true
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "vrfPayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  114,
                  102,
                  45,
                  112,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "beneficiary",
          "writable": true
        },
        {
          "name": "payoutEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "refundRound",
      "docs": [
        "A participant of the round (its ticket's payer, funder or integrator),",
        "or anyone when the round's draw no longer fits its prefund at ORAO's",
        "live fee, never paused, once the round has taken no join for",
        "`refund_slots`, while its draw is unpaid: the round leaves the vault's",
        "books in one step and takes no more joins; each ticket then gets back",
        "exactly what it put in through `return_round_ticket`."
      ],
      "discriminator": [
        177,
        128,
        106,
        163,
        99,
        60,
        213,
        210
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "One of the round's participants (`participant`), or anyone when the",
            "round's draw no longer fits its prefund; nobody is paid to refund",
            "(Spec 09 §6)."
          ],
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "The round, at `[\"round\", id]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "participant",
          "docs": [
            "of the round whose payer or funder is `caller`, or whose integrator is",
            "`caller`'s (`[\"integrator\", caller]`). A sponsorship is not one: any",
            "amount, one lamport, makes a record, so it would let an outsider",
            "refund for one fee. Owner, discriminator and fields checked in the",
            "handler (`is_participant`); only read. Ignored for a round whose draw",
            "no longer fits its prefund, which anyone may refund."
          ]
        },
        {
          "name": "oraoNetworkState",
          "docs": [
            "id, owner checked in the handler, as `join_round` reads it: its live fee",
            "tells whether the round's draw still fits its prefund (`request_fits`)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  111,
                  45,
                  118,
                  114,
                  102,
                  45,
                  110,
                  101,
                  116,
                  119,
                  111,
                  114,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  117,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                7,
                71,
                177,
                26,
                250,
                145,
                180,
                209,
                249,
                34,
                242,
                123,
                14,
                186,
                193,
                218,
                178,
                59,
                33,
                41,
                164,
                190,
                243,
                79,
                50,
                164,
                123,
                88,
                245,
                206,
                252,
                120
              ]
            }
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "registerPayoutTable",
      "docs": [
        "Anyone, never paused: stores a valid payout table at the address of its",
        "hash. Succeeds without writing if it is stored already."
      ],
      "discriminator": [
        210,
        157,
        159,
        65,
        177,
        118,
        196,
        202
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the account's rent, for good: a payout table is never closed."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "payoutTable",
          "docs": [
            "handler from the argument after the table is validated, never taken",
            "from the caller; created there, or read if the program owns it already."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "outcomes",
          "type": {
            "vec": {
              "defined": {
                "name": "outcome"
              }
            }
          }
        }
      ]
    },
    {
      "name": "requestDeposit",
      "discriminator": [
        243,
        202,
        197,
        215,
        135,
        97,
        213,
        109
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "ownerShares",
          "docs": [
            "Where the claim will pay the shares: the owner's canonical account,",
            "created now so that no keeper ever advances someone else's rent."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "shareMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "queue",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Only needed when this request opens an epoch (Spec 08 §4 rule 1)."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "depositQueueUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116,
                  45,
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "request",
          "docs": [
            "The epoch is the one the program computes from the queue and the clock,",
            "never an argument: a caller-chosen epoch would choose its price."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "queue.joiningEpochIdClock.unixTimestamp",
                "account": "queue"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "requestRandomness",
      "docs": [
        "Anyone, from two slots after the open until `T_SETTLE`; after it, only",
        "a request someone created through ORAO at the ticket's seed and ORAO",
        "fulfilled with a non-zero value, bound without funding anything."
      ],
      "discriminator": [
        213,
        5,
        173,
        166,
        37,
        236,
        31,
        18
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; receives the requester's share of the crank fee."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "vrfPayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  114,
                  102,
                  45,
                  112,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "oraoNetworkState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  111,
                  45,
                  118,
                  114,
                  102,
                  45,
                  110,
                  101,
                  116,
                  119,
                  111,
                  114,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  117,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                7,
                71,
                177,
                26,
                250,
                145,
                180,
                209,
                249,
                34,
                242,
                123,
                14,
                186,
                193,
                218,
                178,
                59,
                33,
                41,
                164,
                190,
                243,
                79,
                50,
                164,
                123,
                88,
                245,
                206,
                252,
                120
              ]
            }
          }
        },
        {
          "name": "oraoTreasury",
          "writable": true
        },
        {
          "name": "request",
          "writable": true
        },
        {
          "name": "oraoProgram",
          "address": "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "requestRoundDraw",
      "docs": [
        "Anyone, never paused, paid the round's request share: one ORAO request",
        "for every ticket of a paid round, from two slots after its close until",
        "`T_SETTLE`. The round's tickets are already in the epoch counters,",
        "recorded when it became paid."
      ],
      "discriminator": [
        60,
        38,
        56,
        179,
        242,
        31,
        80,
        18
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; receives the round's request share."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "docs": [
            "The round, at `[\"round\", id]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "roundVrf",
          "docs": [
            "`[\"round-vrf\", round]` with the round's stored bump: pays ORAO, signed",
            "by the program. System-owned, empty outside the request."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  45,
                  118,
                  114,
                  102
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "oraoNetworkState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  111,
                  45,
                  118,
                  114,
                  102,
                  45,
                  110,
                  101,
                  116,
                  119,
                  111,
                  114,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  117,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                7,
                71,
                177,
                26,
                250,
                145,
                180,
                209,
                249,
                34,
                242,
                123,
                14,
                186,
                193,
                218,
                178,
                59,
                33,
                41,
                164,
                190,
                243,
                79,
                50,
                164,
                123,
                88,
                245,
                206,
                252,
                120
              ]
            }
          }
        },
        {
          "name": "oraoTreasury",
          "writable": true
        },
        {
          "name": "request",
          "writable": true
        },
        {
          "name": "oraoProgram",
          "address": "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "requestWithdraw",
      "discriminator": [
        137,
        95,
        187,
        96,
        250,
        138,
        31,
        182
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "ownerShares",
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "docs": [
            "Where the claim will pay the USDC: the owner's canonical account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "queue",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "Only needed when this request opens an epoch."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "shareEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "clock",
          "address": "SysvarC1ock11111111111111111111111111111111"
        },
        {
          "name": "request",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  116,
                  104,
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "queue.joiningEpochIdClock.unixTimestamp",
                "account": "queue"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "returnRoundTicket",
      "docs": [
        "Anyone, never paused: one ticket of a refunded or forfeited round",
        "leaves it, with what it is owed. Pays the caller the ticket's",
        "settlement share for a forfeited ticket, nothing for a refunded one."
      ],
      "discriminator": [
        243,
        151,
        148,
        75,
        68,
        46,
        179,
        163
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; paid the ticket's settlement share for a forfeited ticket,",
            "nothing for a refunded one."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "The ticket's round, at `[\"round\", ticket.round]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "ticket.round",
                "account": "roundTicket"
              }
            ]
          }
        },
        {
          "name": "integrator",
          "docs": [
            "The ticket's stored integrator."
          ],
          "writable": true
        },
        {
          "name": "ticket",
          "docs": [
            "The ticket, at `[\"round-ticket\", integrator, nonce]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  45,
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "roundTicket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "roundTicket"
              }
            ]
          }
        },
        {
          "name": "payer",
          "docs": [
            "charge after a forfeiture) and the ticket's rent."
          ],
          "writable": true
        },
        {
          "name": "refundTo",
          "docs": [
            "a refunded ticket price goes; inspected before any transfer, and not",
            "read for a forfeited ticket."
          ],
          "writable": true
        },
        {
          "name": "payoutEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rentPayer",
          "docs": [
            "no sponsorship, and then must be `round.rent_payer`",
            "(`RentReceiverRequired`); not read otherwise."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "setParams",
      "docs": [
        "Council only. Applies at once if every change tightens, otherwise queues",
        "it behind the longest delay of the fields it loosens."
      ],
      "discriminator": [
        27,
        234,
        178,
        52,
        147,
        2,
        187,
        141
      ],
      "accounts": [
        {
          "name": "council",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocolTreasury",
          "docs": [
            "The treasury the change sets; the current one to leave it alone."
          ]
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "riskParams"
            }
          }
        }
      ]
    },
    {
      "name": "setPauseFlags",
      "docs": [
        "The guardian may only set flags; the council may also clear them."
      ],
      "discriminator": [
        205,
        167,
        85,
        237,
        144,
        202,
        248,
        175
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The guardian or the council."
          ],
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "docs": [
            "The integrator whose own pause changes, if any."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  103,
                  114,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "integrator.authority",
                "account": "integrator"
              }
            ]
          }
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "pauseFlags",
          "type": "u8"
        },
        {
          "name": "integratorPaused",
          "type": {
            "option": "bool"
          }
        }
      ]
    },
    {
      "name": "setShareAccount",
      "docs": [
        "Signed by the integrator's authority: the only way to move its share account."
      ],
      "discriminator": [
        100,
        171,
        226,
        215,
        6,
        73,
        125,
        202
      ],
      "accounts": [
        {
          "name": "integratorAuthority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  103,
                  114,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "integratorAuthority"
              }
            ]
          }
        },
        {
          "name": "shareAccount",
          "docs": [
            "Any USDC account: an integrator may route its share anywhere."
          ]
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "setShareMetadata",
      "docs": [
        "Council only: the share mint's name, symbol and logo in wallets",
        "(Token Metadata). Creates the metadata on the first call, rewrites it after."
      ],
      "discriminator": [
        106,
        202,
        192,
        212,
        13,
        208,
        211,
        35
      ],
      "accounts": [
        {
          "name": "council",
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays the metadata account's rent and Token Metadata's creation fee."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "docs": [
            "The share mint's mint authority and the metadata's update authority."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "metadata",
          "docs": [
            "The share mint's metadata PDA under Token Metadata; created on the first call."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "const",
                "value": [
                  11,
                  112,
                  101,
                  177,
                  227,
                  209,
                  124,
                  69,
                  56,
                  157,
                  82,
                  127,
                  107,
                  4,
                  195,
                  205,
                  88,
                  184,
                  108,
                  115,
                  26,
                  160,
                  253,
                  181,
                  73,
                  182,
                  209,
                  188,
                  3,
                  248,
                  41,
                  70
                ]
              },
              {
                "kind": "account",
                "path": "shareMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                11,
                112,
                101,
                177,
                227,
                209,
                124,
                69,
                56,
                157,
                82,
                127,
                107,
                4,
                195,
                205,
                88,
                184,
                108,
                115,
                26,
                160,
                253,
                181,
                73,
                182,
                209,
                188,
                3,
                248,
                41,
                70
              ]
            }
          }
        },
        {
          "name": "tokenMetadataProgram",
          "address": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "symbol",
          "type": "string"
        },
        {
          "name": "uri",
          "type": "string"
        }
      ]
    },
    {
      "name": "settleRoundTickets",
      "docs": [
        "Anyone, never paused, once the round's randomness is fulfilled; no",
        "deadline. Settles `count` of its tickets, named in remaining accounts",
        "by groups of `ticket`, `integrator`, `payer`, `payout_table`, then",
        "`beneficiary` exactly when bit `i` of `wins` is set; each checked",
        "against the ticket's stored keys. The first settlement of a round",
        "fixes its draw cost. Pays the caller each ticket's settlement share."
      ],
      "discriminator": [
        163,
        231,
        149,
        201,
        242,
        42,
        240,
        91
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone, once the round's randomness is fulfilled; receives each",
            "settled ticket's settlement share."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "The round, at `[\"round\", id]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "roundVrf",
          "docs": [
            "`[\"round-vrf\", round]` with the round's stored bump: holds ORAO's rent",
            "refund after the fulfilment, drained by the first settlement."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  45,
                  118,
                  114,
                  102
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "randomness",
          "docs": [
            "owner, kind, seed and value checked in the handler at the first",
            "settlement, the only one that reads it."
          ]
        },
        {
          "name": "payoutEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rentPayer",
          "docs": [
            "sponsorship, and then must be `round.rent_payer`",
            "(`RentReceiverRequired`); not read otherwise."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "count",
          "type": "u8"
        },
        {
          "name": "wins",
          "type": "u32"
        }
      ]
    },
    {
      "name": "settleTicket",
      "docs": [
        "Anyone, once ORAO has fulfilled; no deadline."
      ],
      "discriminator": [
        201,
        80,
        119,
        145,
        208,
        184,
        168,
        70
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone, once ORAO has fulfilled; receives the settler's share of the crank fee."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "integrator",
          "writable": true
        },
        {
          "name": "ticket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "ticket.integrator",
                "account": "ticket"
              },
              {
                "kind": "account",
                "path": "ticket.nonce",
                "account": "ticket"
              }
            ]
          }
        },
        {
          "name": "vrfPayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  114,
                  102,
                  45,
                  112,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "randomness"
        },
        {
          "name": "beneficiary",
          "writable": true
        },
        {
          "name": "payoutEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "sponsorRound",
      "docs": [
        "Anyone, never paused: `lamports` to a round's draw, until its request.",
        "Returned pro rata after a draw or a forfeiture, in full after a refund."
      ],
      "discriminator": [
        50,
        13,
        178,
        71,
        135,
        196,
        84,
        77
      ],
      "accounts": [
        {
          "name": "sponsor",
          "docs": [
            "Pays the sponsorship and, for a new record, its rent; gets back what",
            "the draw does not use, and the rent, through `reclaim_sponsorship`."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "docs": [
            "Its epoch counters record the round's tickets if this sponsorship pays it."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "The round, at `[\"round\", id]` with its stored bump."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.id",
                "account": "round"
              }
            ]
          }
        },
        {
          "name": "sponsorship",
          "docs": [
            "address, created or topped up in the handler by the same function as",
            "`join_round`'s record (`ConstraintSeeds`, `AccountOwnedByWrongProgram`)."
          ],
          "writable": true
        },
        {
          "name": "oraoNetworkState",
          "docs": [
            "id, owner checked when read: the round's draw must still fit its",
            "prefund, as for a join (`DrawUnderfunded`)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  111,
                  45,
                  118,
                  114,
                  102,
                  45,
                  110,
                  101,
                  116,
                  119,
                  111,
                  114,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  117,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                7,
                71,
                177,
                26,
                250,
                145,
                180,
                209,
                249,
                34,
                242,
                123,
                14,
                186,
                193,
                218,
                178,
                59,
                33,
                41,
                164,
                190,
                243,
                79,
                50,
                164,
                123,
                88,
                245,
                206,
                252,
                120
              ]
            }
          }
        },
        {
          "name": "config",
          "docs": [
            "The config, at `[\"config\"]` with its stored bump: its pause flags."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "strikeEpoch",
      "docs": [
        "Anyone, once the live epoch has closed and no ticket opened before the",
        "close is still open."
      ],
      "discriminator": [
        142,
        118,
        147,
        245,
        251,
        183,
        34,
        93
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; advances the record's rent, which the strike fund reimburses,",
            "and receives `STRIKE_REWARD` from the fund."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "queue",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "record",
          "docs": [
            "Written once; afterwards only its count of pending readers changes."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  112,
                  111,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "queue.current.epochId",
                "account": "queue"
              }
            ]
          }
        },
        {
          "name": "depositQueueUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116,
                  45,
                  113,
                  117,
                  101,
                  117,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "vaultUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  45,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "payableUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  97,
                  98,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "shareEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  45,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "shareClaims",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  104,
                  97,
                  114,
                  101,
                  45,
                  99,
                  108,
                  97,
                  105,
                  109,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "vaultAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "sweepRoundVrf",
      "docs": [
        "Anyone, never paused, unpaid: the lamports on round `round_id`'s",
        "`round_vrf` after its last drain (ORAO's refund for a request fulfilled",
        "after the round forfeited, or a transfer), into the round while it",
        "exists and is not `Requested`, to the caller once it has closed.",
        "Nothing to sweep succeeds without moving anything."
      ],
      "discriminator": [
        82,
        48,
        181,
        66,
        134,
        194,
        108,
        7
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; receives what a closed round's `round_vrf` holds, nothing",
            "otherwise."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "docs": [
            "Read for `next_round_id`: only a round the vault created is swept."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "round",
          "docs": [
            "`Round` while the program owns it; any other owner means the round has",
            "closed (a round's address is never used again), and it is not read."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "roundId"
              }
            ]
          }
        },
        {
          "name": "roundVrf",
          "docs": [
            "`[\"round-vrf\", round]`, signed by the program."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100,
                  45,
                  118,
                  114,
                  102
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "roundId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sweepTicketVrf",
      "docs": [
        "Anyone, never paused, unpaid: the lamports on a closed direct ticket's",
        "`vrf_payer` (ORAO's refund for a request fulfilled after the ticket",
        "expired, or a transfer), to the caller. Nothing to sweep succeeds",
        "without moving anything."
      ],
      "discriminator": [
        150,
        251,
        4,
        133,
        210,
        149,
        96,
        241
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone; receives what a closed ticket's `vrf_payer` holds."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "integrator",
          "docs": [
            "Read for `next_nonce`: only a ticket the integrator opened is swept."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  103,
                  114,
                  97,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "integrator.authority",
                "account": "integrator"
              }
            ]
          }
        },
        {
          "name": "ticket",
          "docs": [
            "its owner is read: a ticket's address is never used again, so any",
            "owner but this program means the ticket has closed."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  99,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "integrator"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "vrfPayer",
          "docs": [
            "`[\"vrf-payer\", ticket]`, signed by the program."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  114,
                  102,
                  45,
                  112,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "ticket"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "depositRequest",
      "discriminator": [
        86,
        27,
        56,
        8,
        25,
        62,
        62,
        243
      ]
    },
    {
      "name": "epochRecord",
      "discriminator": [
        193,
        72,
        26,
        28,
        161,
        98,
        58,
        132
      ]
    },
    {
      "name": "integrator",
      "discriminator": [
        188,
        141,
        128,
        161,
        231,
        248,
        0,
        128
      ]
    },
    {
      "name": "payoutTable",
      "discriminator": [
        229,
        137,
        143,
        236,
        161,
        223,
        173,
        188
      ]
    },
    {
      "name": "queue",
      "discriminator": [
        204,
        167,
        6,
        247,
        20,
        33,
        2,
        188
      ]
    },
    {
      "name": "round",
      "discriminator": [
        87,
        127,
        165,
        51,
        73,
        78,
        116,
        174
      ]
    },
    {
      "name": "roundTicket",
      "discriminator": [
        159,
        187,
        158,
        216,
        109,
        75,
        242,
        129
      ]
    },
    {
      "name": "sponsorship",
      "discriminator": [
        191,
        110,
        48,
        7,
        9,
        44,
        168,
        248
      ]
    },
    {
      "name": "ticket",
      "discriminator": [
        41,
        228,
        24,
        165,
        78,
        90,
        235,
        200
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    },
    {
      "name": "withdrawRequest",
      "discriminator": [
        186,
        239,
        174,
        191,
        189,
        13,
        47,
        196
      ]
    }
  ],
  "events": [
    {
      "name": "claimDelivered",
      "discriminator": [
        153,
        180,
        207,
        20,
        6,
        69,
        10,
        36
      ]
    },
    {
      "name": "depositClaimed",
      "discriminator": [
        119,
        147,
        244,
        76,
        141,
        103,
        170,
        176
      ]
    },
    {
      "name": "depositRequested",
      "discriminator": [
        35,
        33,
        229,
        138,
        116,
        238,
        192,
        22
      ]
    },
    {
      "name": "epochStruck",
      "discriminator": [
        104,
        123,
        204,
        144,
        191,
        189,
        72,
        242
      ]
    },
    {
      "name": "initialized",
      "discriminator": [
        208,
        213,
        115,
        98,
        115,
        82,
        201,
        209
      ]
    },
    {
      "name": "integratorCreated",
      "discriminator": [
        154,
        43,
        148,
        226,
        179,
        128,
        14,
        229
      ]
    },
    {
      "name": "paramsApplied",
      "discriminator": [
        79,
        221,
        60,
        141,
        244,
        69,
        47,
        209
      ]
    },
    {
      "name": "paramsCancelled",
      "discriminator": [
        160,
        167,
        193,
        145,
        11,
        138,
        30,
        120
      ]
    },
    {
      "name": "paramsChanged",
      "discriminator": [
        174,
        49,
        9,
        64,
        58,
        171,
        241,
        24
      ]
    },
    {
      "name": "pauseFlagsChanged",
      "discriminator": [
        56,
        73,
        67,
        44,
        237,
        239,
        68,
        124
      ]
    },
    {
      "name": "payoutClaimed",
      "discriminator": [
        200,
        39,
        105,
        112,
        116,
        63,
        58,
        149
      ]
    },
    {
      "name": "payoutTableRegistered",
      "discriminator": [
        96,
        26,
        125,
        123,
        123,
        2,
        69,
        139
      ]
    },
    {
      "name": "randomnessRequested",
      "discriminator": [
        10,
        64,
        183,
        29,
        104,
        63,
        90,
        149
      ]
    },
    {
      "name": "roundClosed",
      "discriminator": [
        45,
        243,
        28,
        22,
        132,
        70,
        175,
        226
      ]
    },
    {
      "name": "roundDrawRequested",
      "discriminator": [
        224,
        251,
        117,
        114,
        235,
        120,
        85,
        102
      ]
    },
    {
      "name": "roundDrawn",
      "discriminator": [
        147,
        89,
        5,
        223,
        177,
        229,
        18,
        87
      ]
    },
    {
      "name": "roundEntropyRecorded",
      "discriminator": [
        219,
        129,
        175,
        130,
        40,
        212,
        128,
        37
      ]
    },
    {
      "name": "roundExpired",
      "discriminator": [
        93,
        120,
        89,
        173,
        92,
        124,
        70,
        38
      ]
    },
    {
      "name": "roundOpened",
      "discriminator": [
        99,
        173,
        228,
        72,
        142,
        57,
        109,
        178
      ]
    },
    {
      "name": "roundPaid",
      "discriminator": [
        225,
        220,
        210,
        19,
        148,
        21,
        127,
        154
      ]
    },
    {
      "name": "roundPayoutClaimed",
      "discriminator": [
        119,
        161,
        155,
        239,
        77,
        206,
        176,
        16
      ]
    },
    {
      "name": "roundRefunded",
      "discriminator": [
        203,
        164,
        53,
        34,
        132,
        31,
        105,
        230
      ]
    },
    {
      "name": "roundSponsored",
      "discriminator": [
        79,
        27,
        38,
        239,
        209,
        251,
        209,
        132
      ]
    },
    {
      "name": "roundTicketReturned",
      "discriminator": [
        21,
        255,
        186,
        248,
        64,
        109,
        130,
        148
      ]
    },
    {
      "name": "roundTicketSettled",
      "discriminator": [
        37,
        42,
        193,
        215,
        154,
        32,
        139,
        127
      ]
    },
    {
      "name": "roundVrfSwept",
      "discriminator": [
        198,
        32,
        245,
        136,
        178,
        120,
        52,
        152
      ]
    },
    {
      "name": "shareAccountChanged",
      "discriminator": [
        249,
        118,
        104,
        137,
        89,
        217,
        64,
        5
      ]
    },
    {
      "name": "shareMetadataSet",
      "discriminator": [
        40,
        99,
        178,
        110,
        127,
        67,
        58,
        252
      ]
    },
    {
      "name": "sharesClaimed",
      "discriminator": [
        135,
        17,
        55,
        130,
        218,
        208,
        153,
        101
      ]
    },
    {
      "name": "sponsorshipReclaimed",
      "discriminator": [
        22,
        131,
        158,
        20,
        185,
        221,
        35,
        241
      ]
    },
    {
      "name": "ticketEntropyRecorded",
      "discriminator": [
        98,
        238,
        250,
        26,
        243,
        83,
        87,
        216
      ]
    },
    {
      "name": "ticketExpired",
      "discriminator": [
        225,
        164,
        213,
        172,
        133,
        203,
        222,
        131
      ]
    },
    {
      "name": "ticketJoined",
      "discriminator": [
        168,
        83,
        152,
        139,
        192,
        232,
        216,
        174
      ]
    },
    {
      "name": "ticketOpened",
      "discriminator": [
        224,
        38,
        43,
        125,
        232,
        170,
        103,
        203
      ]
    },
    {
      "name": "ticketSettled",
      "discriminator": [
        72,
        40,
        13,
        3,
        184,
        159,
        190,
        211
      ]
    },
    {
      "name": "ticketVrfSwept",
      "discriminator": [
        90,
        218,
        34,
        69,
        163,
        46,
        175,
        114
      ]
    },
    {
      "name": "withdrawClaimed",
      "discriminator": [
        77,
        130,
        89,
        38,
        239,
        172,
        174,
        85
      ]
    },
    {
      "name": "withdrawRequested",
      "discriminator": [
        114,
        16,
        240,
        206,
        93,
        128,
        151,
        39
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notUpgradeAuthority",
      "msg": "signer is not the program's upgrade authority"
    },
    {
      "code": 6001,
      "name": "invalidParams",
      "msg": "parameters are out of range"
    },
    {
      "code": 6002,
      "name": "paused",
      "msg": "this operation is paused"
    },
    {
      "code": 6003,
      "name": "notCouncil",
      "msg": "signer is not the council"
    },
    {
      "code": 6004,
      "name": "notGuardian",
      "msg": "signer is neither the council nor the guardian"
    },
    {
      "code": 6005,
      "name": "guardianCannotUnpause",
      "msg": "the guardian may only set pause flags, never clear them"
    },
    {
      "code": 6006,
      "name": "noPendingChange",
      "msg": "no parameter change is pending"
    },
    {
      "code": 6007,
      "name": "changeNotDue",
      "msg": "the pending parameter change is not due yet"
    },
    {
      "code": 6008,
      "name": "wrongMint",
      "msg": "wrong mint"
    },
    {
      "code": 6009,
      "name": "mathOverflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6010,
      "name": "zeroAmount",
      "msg": "amount must be non-zero"
    },
    {
      "code": 6011,
      "name": "remainingAccounts",
      "msg": "unexpected remaining accounts"
    },
    {
      "code": 6012,
      "name": "outcomeCount",
      "msg": "payout table: zero outcomes or more than 32"
    },
    {
      "code": 6013,
      "name": "probabilityRange",
      "msg": "payout table: a probability of zero or above 1"
    },
    {
      "code": 6014,
      "name": "probabilitySum",
      "msg": "payout table: probabilities do not sum to exactly 1"
    },
    {
      "code": 6015,
      "name": "multiplierCeiling",
      "msg": "payout table: a multiplier above 10 000x"
    },
    {
      "code": 6016,
      "name": "payoutTableOverpays",
      "msg": "payout table: pays out more than it takes in on average"
    },
    {
      "code": 6017,
      "name": "marginFloor",
      "msg": "payout table margin does not cover the vault margin floor plus the protocol and app shares"
    },
    {
      "code": 6018,
      "name": "appShareTooHigh",
      "msg": "app share above the maximum"
    },
    {
      "code": 6019,
      "name": "priceBounds",
      "msg": "ticket price below the minimum or above the maximum"
    },
    {
      "code": 6020,
      "name": "perTicketCap",
      "msg": "worst-case payout above the per-ticket cap"
    },
    {
      "code": 6021,
      "name": "integratorCap",
      "msg": "integrator exposure above its ceiling"
    },
    {
      "code": 6022,
      "name": "utilisationBreaker",
      "msg": "utilisation breaker: the vault is too committed"
    },
    {
      "code": 6023,
      "name": "globalExposure",
      "msg": "reserved liability would exceed kappa of assets"
    },
    {
      "code": 6024,
      "name": "insolvent",
      "msg": "the vault could not pay every open ticket at once"
    },
    {
      "code": 6025,
      "name": "drawdownBreaker",
      "msg": "drawdown breaker: the share price fell too far in 24 hours"
    },
    {
      "code": 6026,
      "name": "wrongNonce",
      "msg": "ticket nonce must equal the integrator's next nonce"
    },
    {
      "code": 6027,
      "name": "integratorPaused",
      "msg": "this integrator is paused"
    },
    {
      "code": 6028,
      "name": "shareAccountMismatch",
      "msg": "share account differs from the integrator record"
    },
    {
      "code": 6029,
      "name": "wrongTicketStatus",
      "msg": "the ticket is not in the state this instruction needs"
    },
    {
      "code": 6030,
      "name": "requestWindow",
      "msg": "randomness may only be requested from two slots after the open until T_SETTLE"
    },
    {
      "code": 6031,
      "name": "entropyUnavailable",
      "msg": "SlotHashes holds no slot after the open"
    },
    {
      "code": 6032,
      "name": "networkStateUnreadable",
      "msg": "ORAO network state could not be read"
    },
    {
      "code": 6033,
      "name": "treasuryMismatch",
      "msg": "treasury does not match ORAO network state"
    },
    {
      "code": 6034,
      "name": "wrongRandomnessAccount",
      "msg": "randomness account is not the one bound to this ticket"
    },
    {
      "code": 6035,
      "name": "notFulfilled",
      "msg": "randomness is not fulfilled"
    },
    {
      "code": 6036,
      "name": "alreadyFulfilled",
      "msg": "randomness is fulfilled: settle, do not expire"
    },
    {
      "code": 6037,
      "name": "notExpired",
      "msg": "T_SETTLE has not elapsed"
    },
    {
      "code": 6038,
      "name": "drawFailed",
      "msg": "no outcome could be drawn"
    },
    {
      "code": 6039,
      "name": "beneficiaryMismatch",
      "msg": "beneficiary differs from the one stored at open"
    },
    {
      "code": 6040,
      "name": "noLiveEpoch",
      "msg": "no epoch is live"
    },
    {
      "code": 6041,
      "name": "epochNotClosed",
      "msg": "the epoch has not closed yet"
    },
    {
      "code": 6042,
      "name": "strikeNotClean",
      "msg": "a ticket opened before the close is still open"
    },
    {
      "code": 6043,
      "name": "belowMinimum",
      "msg": "request below the minimum"
    },
    {
      "code": 6044,
      "name": "firstDepositTooSmall",
      "msg": "a first deposit must be at least min_first_deposit"
    },
    {
      "code": 6045,
      "name": "forbiddenComposition",
      "msg": "a top-level instruction of this transaction is not allowed with a request"
    },
    {
      "code": 6046,
      "name": "wrongRecord",
      "msg": "the record does not belong to this request's epoch or chain"
    },
    {
      "code": 6047,
      "name": "entryRecordRequired",
      "msg": "the epoch record of the request's entry is required"
    },
    {
      "code": 6048,
      "name": "rentReceiverRequired",
      "msg": "the account that advanced the record's rent is required"
    },
    {
      "code": 6049,
      "name": "nothingToClaim",
      "msg": "nothing to claim yet"
    },
    {
      "code": 6050,
      "name": "wrongOwner",
      "msg": "wrong owner"
    },
    {
      "code": 6051,
      "name": "notStruck",
      "msg": "the request's epoch has not been struck"
    },
    {
      "code": 6052,
      "name": "vaultRequired",
      "msg": "this request opens an epoch: the vault account is required"
    },
    {
      "code": 6053,
      "name": "destinationUnusable",
      "msg": "the owner's token account cannot receive yet"
    },
    {
      "code": 6054,
      "name": "wrongRound",
      "msg": "the round is neither the accepting round nor the next one"
    },
    {
      "code": 6055,
      "name": "roundNotAccepting",
      "msg": "the round accepts no more sponsorship"
    },
    {
      "code": 6056,
      "name": "roundCapacity",
      "msg": "the round's liability would exceed what its paid share of the draw allows"
    },
    {
      "code": 6057,
      "name": "roundPaid",
      "msg": "the round's draw is paid: no refund"
    },
    {
      "code": 6058,
      "name": "wrongRoundStatus",
      "msg": "the round is not in the state this instruction needs"
    },
    {
      "code": 6059,
      "name": "refundWindow",
      "msg": "the round's refund window has not opened"
    },
    {
      "code": 6060,
      "name": "roundRequestWindow",
      "msg": "a round's draw may only be requested from two slots after its close until T_SETTLE"
    },
    {
      "code": 6061,
      "name": "drawUnderfunded",
      "msg": "the live draw cost exceeds the round's prefund"
    },
    {
      "code": 6062,
      "name": "wrongPayoutTable",
      "msg": "the payout table account does not match its hash or the ticket"
    },
    {
      "code": 6063,
      "name": "notCanceller",
      "msg": "unused: kept so that the codes after it do not move"
    },
    {
      "code": 6064,
      "name": "shareAccountRequired",
      "msg": "an integrator's first ticket must name its share account"
    },
    {
      "code": 6065,
      "name": "malformedBatch",
      "msg": "the settlement accounts do not follow the ticket layout"
    },
    {
      "code": 6066,
      "name": "roundEpochClosed",
      "msg": "a round counted before the epoch's close takes no join at or after that close"
    },
    {
      "code": 6067,
      "name": "notRoundParticipant",
      "msg": "only a participant of the round, shown by its ticket, may refund it"
    },
    {
      "code": 6068,
      "name": "entropyUnrecorded",
      "msg": "the entropy was never recorded and SlotHashes no longer proves it"
    },
    {
      "code": 6069,
      "name": "entropyStillProven",
      "msg": "SlotHashes still proves the ticket's entropy: record it and expire the ticket"
    }
  ],
  "types": [
    {
      "name": "claimDelivered",
      "docs": [
        "A parked claim handed over once the owner's account could receive."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "deposit",
            "docs": [
              "A deposit request (shares) or a withdrawal request (USDC)."
            ],
            "type": "bool"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultAuthorityBump",
            "docs": [
              "Bump of `[\"vault-authority\"]`, which owns every token account."
            ],
            "type": "u8"
          },
          {
            "name": "council",
            "docs": [
              "Parameter authority, and the only party that lifts a pause."
            ],
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "docs": [
              "May only set pause flags."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolTreasury",
            "docs": [
              "USDC token account receiving the protocol share."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "pauseFlags",
            "docs": [
              "Bit set: see `Config::PAUSE_*`."
            ],
            "type": "u8"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "riskParams"
              }
            }
          },
          {
            "name": "pending",
            "type": {
              "defined": {
                "name": "pendingChange"
              }
            }
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "depositClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "delivered",
            "docs": [
              "The shares reached the owner; otherwise they are parked on the request."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "depositRequest",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "parked",
            "docs": [
              "Set by a claim that could not deliver: the owner's share account could",
              "not receive. The epoch's record is released; `shares_due` waits here."
            ],
            "type": "bool"
          },
          {
            "name": "sharesDue",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "depositRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "epochRecord",
      "docs": [
        "Written once by the strike; only `pending` changes afterwards (Spec 08 §2.3)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "closeTs",
            "type": "i64"
          },
          {
            "name": "struckTs",
            "type": "i64"
          },
          {
            "name": "totalAssets",
            "docs": [
              "The vault's settled assets and its shares at the strike, before its",
              "flows: these fix the price."
            ],
            "type": "u64"
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "deposits",
            "type": "u64"
          },
          {
            "name": "sharesMinted",
            "type": "u64"
          },
          {
            "name": "withdrawShares",
            "type": "u64"
          },
          {
            "name": "assetsOwed",
            "type": "u64"
          },
          {
            "name": "assetsPaid",
            "type": "u64"
          },
          {
            "name": "sharesBurnt",
            "type": "u64"
          },
          {
            "name": "chainId",
            "docs": [
              "The epoch id the withdrawal chain this strike belongs to started at."
            ],
            "type": "u64"
          },
          {
            "name": "rBefore",
            "type": "u128"
          },
          {
            "name": "vBefore",
            "type": "u128"
          },
          {
            "name": "rAfter",
            "type": "u128"
          },
          {
            "name": "vAfter",
            "type": "u128"
          },
          {
            "name": "pending",
            "docs": [
              "Requests whose remaining claims still read this record."
            ],
            "type": "u32"
          },
          {
            "name": "requests",
            "docs": [
              "Requests made in this epoch."
            ],
            "type": "u32"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Where the rent goes when the record closes: the queue (the strike fund",
              "advanced it) or the striker (the fund could not)."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "epochStruck",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "totalAssets",
            "type": "u64"
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "deposits",
            "type": "u64"
          },
          {
            "name": "sharesMinted",
            "type": "u64"
          },
          {
            "name": "withdrawShares",
            "type": "u64"
          },
          {
            "name": "assetsOwed",
            "type": "u64"
          },
          {
            "name": "assetsPaid",
            "type": "u64"
          },
          {
            "name": "sharesBurnt",
            "type": "u64"
          },
          {
            "name": "reward",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "initialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "council",
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "protocolTreasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "integrator",
      "docs": [
        "An integrator's record, keyed on the address that signs its tickets (Spec 08 §2.5).",
        "Never closed, so its nonce can never restart."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "shareAccount",
            "docs": [
              "USDC account receiving the app share; changed only by `set_share_account`."
            ],
            "type": "pubkey"
          },
          {
            "name": "reservedLiability",
            "type": "u64"
          },
          {
            "name": "openTickets",
            "type": "u64"
          },
          {
            "name": "nextNonce",
            "type": "u64"
          },
          {
            "name": "volumeTotal",
            "type": "u64"
          },
          {
            "name": "paused",
            "docs": [
              "Set by the guardian or the council: this integrator's new tickets are refused."
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "appSharesAccrued",
            "docs": [
              "App shares of its settled and forfeited beacon tickets, not yet claimed",
              "(Spec 08 §13.2.6); taken from the reserved tail."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                56
              ]
            }
          }
        ]
      }
    },
    {
      "name": "integratorCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "shareAccount",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "liveEpoch",
      "docs": [
        "One live epoch in `Queue` (Spec 08 §2.2)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "live",
            "type": "bool"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "closeTs",
            "docs": [
              "0 for `next` until it is promoted."
            ],
            "type": "i64"
          },
          {
            "name": "deposits",
            "type": "u64"
          },
          {
            "name": "withdrawShares",
            "docs": [
              "Queued withdrawal shares, including those rolled from a rationed strike."
            ],
            "type": "u64"
          },
          {
            "name": "depositRequests",
            "type": "u32"
          },
          {
            "name": "withdrawRequests",
            "docs": [
              "New withdrawal requests of this epoch; rolled ones are counted by the chain."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "outcome",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "p",
            "docs": [
              "Probability in 1e-9."
            ],
            "type": "u64"
          },
          {
            "name": "m",
            "docs": [
              "Multiplier in bps."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "paramsApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "paramsCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "paramsChanged",
      "docs": [
        "`set_params` applied a change at once (`effective_at` = now) or queued it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "applied",
            "type": "bool"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pauseFlagsChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "by",
            "type": "pubkey"
          },
          {
            "name": "pauseFlags",
            "type": "u8"
          },
          {
            "name": "integrator",
            "docs": [
              "The integrator whose pause changed, or the default key."
            ],
            "type": "pubkey"
          },
          {
            "name": "integratorPaused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "payoutClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "beneficiary",
            "type": "pubkey"
          },
          {
            "name": "payout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "payoutTable",
      "docs": [
        "A payout table stored once, at `[\"payout-table\", hash]` (Spec 08 §13.2.1).",
        "Immutable and never closed: a beacon ticket stores its address instead of",
        "its outcomes. It holds no share and no margin floor, which depend on the",
        "ticket's app share and the live parameters and are checked at each join."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "len",
            "type": "u8"
          },
          {
            "name": "lhs",
            "docs": [
              "`Σ p·m` of the outcomes, from `payout_table::validate`."
            ],
            "type": "u128"
          },
          {
            "name": "maxM",
            "docs": [
              "The largest multiplier, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "hash",
            "docs": [
              "`SHA256(\"FADE/PAYOUT-TABLE/v1\" ‖ len ‖ p₀ ‖ m₀ ‖ …)`, little-endian `u64`s."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outcomes",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "outcome"
                  }
                },
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "payoutTableRegistered",
      "docs": [
        "`register_payout_table` created a payout table; a re-registration emits nothing."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "payoutTable",
            "type": "pubkey"
          },
          {
            "name": "hash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "len",
            "type": "u8"
          },
          {
            "name": "lhs",
            "type": "u128"
          },
          {
            "name": "maxM",
            "type": "u64"
          },
          {
            "name": "outcomes",
            "docs": [
              "The `len` outcomes `hash` commits to, so the table is known from the events alone."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "outcome"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "pendingChange",
      "docs": [
        "At most one queued parameter change (Spec 08 §7)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "riskParams"
              }
            }
          },
          {
            "name": "protocolTreasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "queue",
      "docs": [
        "The liquidity-provider side (Spec 08 §2.2). Its lamports above its own",
        "rent-exempt minimum are the strike fund."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "current",
            "type": {
              "defined": {
                "name": "liveEpoch"
              }
            }
          },
          {
            "name": "next",
            "type": {
              "defined": {
                "name": "liveEpoch"
              }
            }
          },
          {
            "name": "nextEpochId",
            "docs": [
              "The id the next epoch to be created receives. Starts at 1."
            ],
            "type": "u64"
          },
          {
            "name": "chainId",
            "docs": [
              "The epoch id the running withdrawal chain started at, or 0."
            ],
            "type": "u64"
          },
          {
            "name": "chainR",
            "docs": [
              "Chain indices of Spec 08 §5, `INDEX_SCALE` fixed point."
            ],
            "type": "u128"
          },
          {
            "name": "chainV",
            "type": "u128"
          },
          {
            "name": "chainRequests",
            "docs": [
              "Withdrawal requests of struck epochs still waiting for the chain to end."
            ],
            "type": "u32"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "randomnessRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entropySlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "riskParams",
      "docs": [
        "Governable parameters: the Technical Specification's §2 table. Settlement",
        "never reads them; everything a ticket needs is snapshotted at open."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kellyFractionBps",
            "docs": [
              "Fraction of the Kelly-optimal liability a ticket may take, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "censorshipBps",
            "docs": [
              "Flat ceiling on a ticket's liability as a fraction of assets, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "whaleBps",
            "docs": [
              "One integrator's open liability as a fraction of assets, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "utilisationBreakerBps",
            "docs": [
              "Committed fraction of assets above which new tickets are refused, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "kappaBps",
            "docs": [
              "Reserved liability as a fraction of assets never exceeded, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "drawdownBps",
            "docs": [
              "Fall of the share price within 24 hours that stops new tickets, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "minPrice",
            "type": "u64"
          },
          {
            "name": "maxPrice",
            "type": "u64"
          },
          {
            "name": "minVaultMarginBps",
            "docs": [
              "Smallest share of the ticket price the vault must earn in expectation, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "protocolShareBps",
            "docs": [
              "Taken from the ticket price at open, to the treasury, in bps."
            ],
            "type": "u64"
          },
          {
            "name": "maxAppShareBps",
            "type": "u64"
          },
          {
            "name": "tSettleSlots",
            "docs": [
              "Slots from open after which an unfulfilled ticket can be expired."
            ],
            "type": "u64"
          },
          {
            "name": "crankRequestLamports",
            "docs": [
              "Part of the crank fee paid to whoever requests the randomness, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "crankSettleLamports",
            "docs": [
              "Part of the crank fee paid to whoever settles or expires, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "epochLengthSeconds",
            "type": "u64"
          },
          {
            "name": "claimFeeLamports",
            "docs": [
              "Held in each request, paid to whoever claims it, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "strikeFeeLamports",
            "docs": [
              "Paid into the strike fund by a request while the fund is below target, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "strikeRewardLamports",
            "docs": [
              "Paid from the strike fund to whoever strikes an epoch, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "fundTargetLamports",
            "type": "u64"
          },
          {
            "name": "minDeposit",
            "docs": [
              "Smallest deposit request, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "minWithdrawShares",
            "docs": [
              "Smallest withdrawal request, in share base units, unless it is the owner's whole balance."
            ],
            "type": "u64"
          },
          {
            "name": "minFirstDeposit",
            "docs": [
              "Smallest deposit while no share exists."
            ],
            "type": "u64"
          },
          {
            "name": "creditEnabled",
            "type": "bool"
          },
          {
            "name": "creditBase",
            "type": "u64"
          },
          {
            "name": "creditRateBps",
            "type": "u64"
          },
          {
            "name": "beaconMinPrice",
            "docs": [
              "Smallest beacon ticket price, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "beaconThreshold",
            "docs": [
              "`T_r`: the ticket prices that pay a round's whole draw, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "roundK",
            "docs": [
              "`k`: per-ticket caps a paid round may carry; at most `MAX_ROUND_K`."
            ],
            "type": "u64"
          },
          {
            "name": "tickSlots",
            "docs": [
              "A paid round closes at the next multiple of `tick_slots`."
            ],
            "type": "u64"
          },
          {
            "name": "refundSlots",
            "docs": [
              "Slots after a round's latest join from which an unpaid round may be refunded."
            ],
            "type": "u64"
          },
          {
            "name": "crankRoundSettleLamports",
            "docs": [
              "Settlement share of a beacon ticket, paid to whoever settles or returns it, lamports."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "round",
      "docs": [
        "One draw shared by the tickets that joined it, at `[\"round\", id]`",
        "(Spec 08 §13.2.2). Prepays and sponsorship are held in its lamports."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vrfBump",
            "docs": [
              "Bump of `[\"round-vrf\", round]`."
            ],
            "type": "u8"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "roundStatus"
              }
            }
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "rentPayer",
            "docs": [
              "Advanced the round's rent; receives it, with the dust, at close."
            ],
            "type": "pubkey"
          },
          {
            "name": "firstSlot",
            "docs": [
              "Slot of the first join."
            ],
            "type": "u64"
          },
          {
            "name": "paidSlot",
            "docs": [
              "Slot in which the round became paid; 0 until then."
            ],
            "type": "u64"
          },
          {
            "name": "closeSlot",
            "docs": [
              "First tick boundary after `paid_slot`; 0 until paid."
            ],
            "type": "u64"
          },
          {
            "name": "threshold",
            "docs": [
              "`T_r`, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "drawMax",
            "docs": [
              "`D_r`, lamports: two ORAO fees, a pending request's rent and the request share."
            ],
            "type": "u64"
          },
          {
            "name": "roundK",
            "type": "u8"
          },
          {
            "name": "minPrice",
            "type": "u64"
          },
          {
            "name": "settleShare",
            "type": "u64"
          },
          {
            "name": "requestShare",
            "type": "u64"
          },
          {
            "name": "tickSlots",
            "type": "u64"
          },
          {
            "name": "refundSlots",
            "type": "u64"
          },
          {
            "name": "tSettleSlots",
            "type": "u64"
          },
          {
            "name": "drawdownBps",
            "type": "u64"
          },
          {
            "name": "prices",
            "docs": [
              "`R`: ticket prices of every ticket that joined."
            ],
            "type": "u64"
          },
          {
            "name": "sponsorship",
            "docs": [
              "`S`: sponsorship received, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "liability",
            "type": "u64"
          },
          {
            "name": "credits",
            "type": "u64"
          },
          {
            "name": "protocolShares",
            "type": "u64"
          },
          {
            "name": "appShares",
            "type": "u64"
          },
          {
            "name": "prepaid",
            "docs": [
              "Prepays held on the round and not yet returned, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "usage",
            "docs": [
              "`U`: Σ of the tickets' capacity usage, `USAGE_SCALE` fixed point."
            ],
            "type": "u64"
          },
          {
            "name": "tickets",
            "docs": [
              "Tickets joined and not yet settled or returned."
            ],
            "type": "u32"
          },
          {
            "name": "sponsors",
            "docs": [
              "Sponsorships not yet reclaimed."
            ],
            "type": "u32"
          },
          {
            "name": "counted",
            "docs": [
              "Recorded in the epoch counters."
            ],
            "type": "bool"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "generation",
            "type": "u32"
          },
          {
            "name": "randomness",
            "docs": [
              "The ORAO request account."
            ],
            "type": "pubkey"
          },
          {
            "name": "seed",
            "docs": [
              "The round's seed and its entropy slot `s*`, recorded while SlotHashes",
              "proves `s*` by `record_round_entropy`, `request_round_draw` or the",
              "expiry that looked for its request; zero until then. Once recorded,",
              "the round's ORAO request address no longer depends on SlotHashes."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entropySlot",
            "type": "u64"
          },
          {
            "name": "funded",
            "docs": [
              "Lamports moved to `round_vrf` for the request."
            ],
            "type": "u64"
          },
          {
            "name": "drawCost",
            "docs": [
              "`C`, fixed by the first settlement or the expiry."
            ],
            "type": "u64"
          },
          {
            "name": "drawnRandomness",
            "docs": [
              "`R`, the request's randomness, kept by the first settlement; zero",
              "until then. Every later batch reads it here, so that a drawn round",
              "never depends on ORAO's account staying readable (invariant 10)."
            ],
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "lastJoinSlot",
            "docs": [
              "Slot of the latest join; the refund window counts from it (Spec 09 §6",
              "as built). Taken from the spare tail: a round written before it reads",
              "0, and `refund_from` then counts from `first_slot`."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                24
              ]
            }
          }
        ]
      }
    },
    {
      "name": "roundClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "rentPayer",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundDrawRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entropySlot",
            "type": "u64"
          },
          {
            "name": "entropyHash",
            "docs": [
              "`h*`; zero when the round's entropy was recorded before the request and",
              "SlotHashes no longer holds `s*` (a late binding): `RoundEntropyRecorded`",
              "carries it then."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "funded",
            "type": "u64"
          },
          {
            "name": "side",
            "docs": [
              "The epoch counter the round's tickets joined when it became paid, and",
              "its generation; the request does not change them."
            ],
            "type": "u8"
          },
          {
            "name": "generation",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "roundDrawn",
      "docs": [
        "The first settlement of a round read its randomness and fixed its draw cost."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "drawCost",
            "type": "u64"
          },
          {
            "name": "refund",
            "docs": [
              "Lamports drained back from `round_vrf`."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundEntropyRecorded",
      "docs": [
        "A paid round's seed and entropy slot, recorded while SlotHashes proved `s*`:",
        "its ORAO request address no longer depends on the sysvar."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entropySlot",
            "type": "u64"
          },
          {
            "name": "entropyHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "roundExpired",
      "docs": [
        "`requested` tells a keeper's failure (false) from a withheld draw (true)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "requested",
            "type": "bool"
          },
          {
            "name": "requestFound",
            "docs": [
              "An ORAO request exists for the round's seed: bound when `requested`, created",
              "through ORAO by someone and never bound otherwise (pending or fulfilled with zero)."
            ],
            "type": "bool"
          },
          {
            "name": "checked",
            "docs": [
              "The program could look for that request: always when `requested`; for a round",
              "never requested, while SlotHashes still proved its entropy slot. The alarm reads a",
              "keeper's failure only from `checked && !request_found`."
            ],
            "type": "bool"
          },
          {
            "name": "tickets",
            "type": "u32"
          },
          {
            "name": "forfeited",
            "docs": [
              "Vault credits forfeited to the vault."
            ],
            "type": "u64"
          },
          {
            "name": "drawCost",
            "docs": [
              "`C` (Spec 08 §13.4), which every forfeited return's charge depends on, and the",
              "lamports drained back from `round_vrf` that fixed it; both 0 when unrequested."
            ],
            "type": "u64"
          },
          {
            "name": "refund",
            "type": "u64"
          },
          {
            "name": "side",
            "docs": [
              "The epoch counter the round's tickets left and its generation, recorded when the",
              "round became paid: no other event gives them for a round never requested."
            ],
            "type": "u8"
          },
          {
            "name": "generation",
            "type": "u32"
          },
          {
            "name": "forfeitsWithheld",
            "docs": [
              "`Vault.forfeits_withheld` after this expiry: when it counts as one a withheld",
              "draw may explain (all but `!requested && checked && !request_found`), its",
              "ordinal in that count, which the keeper's alarm accounts for one by one."
            ],
            "type": "u64"
          },
          {
            "name": "refunded",
            "docs": [
              "The round was refunded, not forfeited: never requested, its entropy never",
              "recorded, and SlotHashes no longer proving it, so that whether its request",
              "exists, fulfilled, can no longer be checked (`checked` false). Every ticket's",
              "price and prepay go back at its return; `forfeited`, `draw_cost` and `refund`",
              "are 0."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "roundOpened",
      "docs": [
        "A join created a round; the round's snapshot (Spec 09 §3)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "rentPayer",
            "type": "pubkey"
          },
          {
            "name": "threshold",
            "type": "u64"
          },
          {
            "name": "drawMax",
            "type": "u64"
          },
          {
            "name": "roundK",
            "type": "u8"
          },
          {
            "name": "minPrice",
            "type": "u64"
          },
          {
            "name": "settleShare",
            "type": "u64"
          },
          {
            "name": "tickSlots",
            "type": "u64"
          },
          {
            "name": "refundSlots",
            "type": "u64"
          },
          {
            "name": "firstSlot",
            "type": "u64"
          },
          {
            "name": "requestShare",
            "type": "u64"
          },
          {
            "name": "tSettleSlots",
            "type": "u64"
          },
          {
            "name": "drawdownBps",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "paidSlot",
            "type": "u64"
          },
          {
            "name": "closeSlot",
            "type": "u64"
          },
          {
            "name": "prices",
            "type": "u64"
          },
          {
            "name": "sponsorship",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundPayoutClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "pubkey"
          },
          {
            "name": "tickets",
            "type": "u32"
          },
          {
            "name": "prices",
            "type": "u64"
          },
          {
            "name": "sponsorship",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundSponsored",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "sponsor",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "total",
            "docs": [
              "The round's sponsorship after this one."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundStatus",
      "docs": [
        "Where a round stands (Spec 08 §13.2.2). \"Closed\" is not a state: a `Paid`",
        "round is closed from `close_slot` on, computed from the slot."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "accepting"
          },
          {
            "name": "paid"
          },
          {
            "name": "requested"
          },
          {
            "name": "drawn"
          },
          {
            "name": "refunded"
          },
          {
            "name": "forfeited"
          }
        ]
      }
    },
    {
      "name": "roundTicket",
      "docs": [
        "A beacon ticket, at `[\"round-ticket\", integrator, nonce]` (Spec 08 §13.2.4).",
        "Lean: the payout table is referenced by address, and everything common to",
        "the round is on the round."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "roundTicketStatus"
              }
            }
          },
          {
            "name": "round",
            "docs": [
              "The round's id."
            ],
            "type": "u64"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "payer",
            "docs": [
              "Paid the rent, the prepay and the settlement share; gets back what is not spent."
            ],
            "type": "pubkey"
          },
          {
            "name": "funder",
            "docs": [
              "Signed for the ticket price."
            ],
            "type": "pubkey"
          },
          {
            "name": "refundTo",
            "docs": [
              "The funder's token account: where a refund returns the ticket price."
            ],
            "type": "pubkey"
          },
          {
            "name": "beneficiary",
            "docs": [
              "Stored at the join, immutable: the only account a payout can go to."
            ],
            "type": "pubkey"
          },
          {
            "name": "payoutTable",
            "docs": [
              "The `PayoutTable` account."
            ],
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "vaultCredit",
            "type": "u64"
          },
          {
            "name": "payoutMax",
            "type": "u64"
          },
          {
            "name": "liability",
            "type": "u64"
          },
          {
            "name": "protocolShare",
            "type": "u64"
          },
          {
            "name": "appShare",
            "type": "u64"
          },
          {
            "name": "prepay",
            "docs": [
              "Lamports held on the round for the draw."
            ],
            "type": "u64"
          },
          {
            "name": "settleShare",
            "docs": [
              "Lamports held on this account above its rent, for whoever settles or returns it."
            ],
            "type": "u64"
          },
          {
            "name": "payout",
            "docs": [
              "Set when the payout or the return is parked."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundTicketReturned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "refunded",
            "docs": [
              "A refunded round (the ticket price returned), or a forfeited one."
            ],
            "type": "bool"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "lamports",
            "docs": [
              "Lamports returned to the payer."
            ],
            "type": "u64"
          },
          {
            "name": "parked",
            "docs": [
              "The ticket price went to `payout_escrow`: `refund_to` could not receive it."
            ],
            "type": "bool"
          },
          {
            "name": "charge",
            "docs": [
              "The ticket's share of the draw, lamports: 0 after a refund."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundTicketSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "charge",
            "docs": [
              "The ticket's share of the draw, lamports."
            ],
            "type": "u64"
          },
          {
            "name": "pending",
            "docs": [
              "The payout went to `payout_escrow`: the beneficiary could not receive it."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "roundTicketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "joined"
          },
          {
            "name": "payoutParked"
          },
          {
            "name": "returnParked"
          }
        ]
      }
    },
    {
      "name": "roundVrfSwept",
      "docs": [
        "Lamports that reached a round's `round_vrf` after its last drain (ORAO's rent",
        "refund for a request fulfilled after the round forfeited, or a transfer), swept."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "docs": [
              "The round's address, whether it still exists or not."
            ],
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "to",
            "docs": [
              "The round while it exists (its close pays them to `rent_payer`), the caller",
              "once it has closed."
            ],
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "closed",
            "docs": [
              "The round had closed: `to` is the caller."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "shareAccountChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "shareAccount",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "shareMetadataSet",
      "docs": [
        "`set_share_metadata` created the share mint's Token Metadata account, or",
        "rewrote it (`created` false)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "created",
            "type": "bool"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "symbol",
            "type": "string"
          },
          {
            "name": "uri",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "sharesClaimed",
      "docs": [
        "`integrator` is the default key for the protocol's shares."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sponsorship",
      "docs": [
        "One sponsor's lamports in one round, at `[\"sponsorship\", round, sponsor]`",
        "(Spec 08 §13.2.5). A second sponsorship by the same sponsor tops it up."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "round",
            "docs": [
              "The round's id."
            ],
            "type": "u64"
          },
          {
            "name": "sponsor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sponsorshipReclaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "sponsor",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ticket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vrfPayerBump",
            "type": "u8"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "ticketStatus"
              }
            }
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "payer",
            "docs": [
              "Paid the rent and the SOL; receives every refund and the rent at close."
            ],
            "type": "pubkey"
          },
          {
            "name": "beneficiary",
            "docs": [
              "Stored at open, immutable: the only account a payout can go to."
            ],
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "vaultCredit",
            "type": "u64"
          },
          {
            "name": "payoutMax",
            "type": "u64"
          },
          {
            "name": "reservedLiability",
            "type": "u64"
          },
          {
            "name": "cap",
            "docs": [
              "The per-ticket cap that applied at open."
            ],
            "type": "u64"
          },
          {
            "name": "marginBps",
            "type": "u64"
          },
          {
            "name": "appShareBps",
            "type": "u64"
          },
          {
            "name": "vaultMarginBps",
            "type": "u64"
          },
          {
            "name": "drawdownBps",
            "docs": [
              "The drawdown threshold at open: settlement records a trip against it",
              "without reading live parameters."
            ],
            "type": "u64"
          },
          {
            "name": "openSlot",
            "type": "u64"
          },
          {
            "name": "openTs",
            "type": "i64"
          },
          {
            "name": "expirySlot",
            "docs": [
              "`open_slot + T_SETTLE`, fixed at open: after it an unfulfilled ticket can be expired."
            ],
            "type": "u64"
          },
          {
            "name": "side",
            "docs": [
              "Which epoch counter the ticket joined, and in which generation."
            ],
            "type": "u8"
          },
          {
            "name": "generation",
            "type": "u32"
          },
          {
            "name": "crankRequestLamports",
            "docs": [
              "Lamports of crank fee still held for the requester and the settler."
            ],
            "type": "u64"
          },
          {
            "name": "crankSettleLamports",
            "type": "u64"
          },
          {
            "name": "randomness",
            "docs": [
              "The ORAO request account, bound by `request_randomness`."
            ],
            "type": "pubkey"
          },
          {
            "name": "entropySlot",
            "docs": [
              "`s*`, `h*` and the ORAO seed, recorded by `record_ticket_entropy` or",
              "`request_randomness`; all zero until then."
            ],
            "type": "u64"
          },
          {
            "name": "entropyHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outcome",
            "docs": [
              "The outcome drawn, or `REFUND_OUTCOME` for a refund parked in",
              "`payout_escrow`; 0 until either."
            ],
            "type": "u8"
          },
          {
            "name": "payout",
            "docs": [
              "Set when the payout (or the refunded credit) waits in `payout_escrow`."
            ],
            "type": "u64"
          },
          {
            "name": "payoutTableLen",
            "type": "u8"
          },
          {
            "name": "payoutTable",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "outcome"
                  }
                },
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "ticketEntropyRecorded",
      "docs": [
        "An Open direct ticket's seed and entropy slot, recorded while SlotHashes",
        "proved `s*`: its ORAO request address no longer depends on the sysvar."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entropySlot",
            "type": "u64"
          },
          {
            "name": "entropyHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "ticketExpired",
      "docs": [
        "A direct ticket's expiry: forfeited by `expire_ticket`, or refunded by",
        "`refund_expired_ticket`. Version 2 (`TICKET_EXPIRED_VERSION`); a version-1",
        "body ends after `forfeited`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "forfeited",
            "docs": [
              "The vault credit forfeited to the vault; 0 for a refund."
            ],
            "type": "u64"
          },
          {
            "name": "requested",
            "docs": [
              "The ticket's randomness was requested: its bound request was pending or",
              "fulfilled with zero."
            ],
            "type": "bool"
          },
          {
            "name": "requestFound",
            "docs": [
              "An ORAO request exists at the ticket's seed: bound when `requested`,",
              "created through ORAO by someone and never bound otherwise (pending or",
              "fulfilled with zero)."
            ],
            "type": "bool"
          },
          {
            "name": "checked",
            "docs": [
              "The program could look for that request: always for a forfeiture,",
              "never for a refund. The alarm reads a keeper's failure only from",
              "`checked && !request_found`."
            ],
            "type": "bool"
          },
          {
            "name": "pending",
            "docs": [
              "The bound request was still pending and `vrf_payer` paid its rent, so",
              "ORAO's rent refund reaches `vrf_payer` when it fulfils it, after the",
              "ticket's close, and `sweep_ticket_vrf` moves it then. False for a",
              "request someone else created and the ticket bound: ORAO refunds its",
              "creator."
            ],
            "type": "bool"
          },
          {
            "name": "refunded",
            "docs": [
              "The ticket was refunded, not forfeited: never requested, its seed never",
              "recorded, and SlotHashes no longer proving it."
            ],
            "type": "bool"
          },
          {
            "name": "refund",
            "docs": [
              "The vault credit returned to the beneficiary (or parked in",
              "`payout_escrow`); 0 unless `refunded`."
            ],
            "type": "u64"
          },
          {
            "name": "parked",
            "docs": [
              "The refund waits in `payout_escrow` for `claim_payout`: the beneficiary",
              "could not receive it. The ticket stays, `PayoutPending` with `outcome`",
              "`REFUND_OUTCOME`."
            ],
            "type": "bool"
          },
          {
            "name": "ticketForfeitsWithheld",
            "docs": [
              "`Vault.ticket_forfeits_withheld` after this expiry: when it counts as",
              "one a withheld draw may explain (all but `!requested && checked &&",
              "!request_found`), its ordinal in that count."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ticketJoined",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "beneficiary",
            "type": "pubkey"
          },
          {
            "name": "refundTo",
            "type": "pubkey"
          },
          {
            "name": "payoutTable",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "vaultCredit",
            "type": "u64"
          },
          {
            "name": "payoutMax",
            "type": "u64"
          },
          {
            "name": "reservedLiability",
            "type": "u64"
          },
          {
            "name": "cap",
            "docs": [
              "The per-ticket cap admission applied, and the capacity usage against it."
            ],
            "type": "u64"
          },
          {
            "name": "usage",
            "type": "u64"
          },
          {
            "name": "protocolShare",
            "type": "u64"
          },
          {
            "name": "appShare",
            "type": "u64"
          },
          {
            "name": "prepay",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "funder",
            "type": "pubkey"
          },
          {
            "name": "settleShare",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ticketOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "beneficiary",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "vaultCredit",
            "type": "u64"
          },
          {
            "name": "payoutMax",
            "type": "u64"
          },
          {
            "name": "reservedLiability",
            "type": "u64"
          },
          {
            "name": "cap",
            "type": "u64"
          },
          {
            "name": "marginBps",
            "type": "u64"
          },
          {
            "name": "appShareBps",
            "type": "u64"
          },
          {
            "name": "openSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ticketSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "type": "pubkey"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "pending",
            "docs": [
              "The payout went to `payout_escrow`: the beneficiary could not receive it."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "ticketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "requested"
          },
          {
            "name": "payoutPending"
          }
        ]
      }
    },
    {
      "name": "ticketVrfSwept",
      "docs": [
        "Lamports that reached a closed direct ticket's `vrf_payer` (ORAO's rent",
        "refund for a request fulfilled after the ticket expired, or a transfer),",
        "swept to the caller."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "ticket",
            "docs": [
              "The ticket's address; the ticket no longer exists."
            ],
            "type": "pubkey"
          },
          {
            "name": "integrator",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "The ticket side (Spec 08 §2.1). Never written by a liquidity-provider",
        "instruction except the strike and the request that opens an epoch."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "totalAssets",
            "docs": [
              "Everything the vault owns, tracked internally — never read from a token account."
            ],
            "type": "u64"
          },
          {
            "name": "totalShares",
            "docs": [
              "Equal to the share mint's supply; only the strike mints and burns."
            ],
            "type": "u64"
          },
          {
            "name": "totalReservedLiability",
            "docs": [
              "`Σ payout_max − vault_credit` of open tickets."
            ],
            "type": "u64"
          },
          {
            "name": "openVaultCredits",
            "docs": [
              "`Σ vault_credit` of open tickets."
            ],
            "type": "u64"
          },
          {
            "name": "openBeforeClose",
            "docs": [
              "Open tickets opened before the live epoch's close (Spec 08 §4)."
            ],
            "type": "u32"
          },
          {
            "name": "openAfterClose",
            "docs": [
              "Open tickets opened at or after it, or while no epoch was live."
            ],
            "type": "u32"
          },
          {
            "name": "generation",
            "type": "u32"
          },
          {
            "name": "closeTs",
            "docs": [
              "The live epoch's close, or 0."
            ],
            "type": "i64"
          },
          {
            "name": "priceMaxima",
            "docs": [
              "Highest share price of each of the last 24 hours (Spec 08 §8)."
            ],
            "type": {
              "array": [
                "u128",
                24
              ]
            }
          },
          {
            "name": "priceHeadHour",
            "type": "i64"
          },
          {
            "name": "drawdownTripTs",
            "docs": [
              "Last time the drawdown condition was seen holding."
            ],
            "type": "i64"
          },
          {
            "name": "volumeTotal",
            "docs": [
              "Cumulative ticket price ever opened."
            ],
            "type": "u64"
          },
          {
            "name": "integrators",
            "type": "u64"
          },
          {
            "name": "afterCloseGain",
            "docs": [
              "Results of tickets opened after the live close that have already closed:",
              "what the vault gained (`vault_credit − payout`) and lost on them. A strike",
              "leaves them out of its price; they are the next epoch's (Spec 08 §4 rule 5)."
            ],
            "type": "u64"
          },
          {
            "name": "afterCloseLoss",
            "type": "u64"
          },
          {
            "name": "acceptingRound",
            "docs": [
              "Id of the round accepting tickets, or 0."
            ],
            "type": "u64"
          },
          {
            "name": "nextRoundId",
            "docs": [
              "Id the next round created receives; starts at 1."
            ],
            "type": "u64"
          },
          {
            "name": "beaconSharesHeld",
            "docs": [
              "Protocol and app shares of beacon tickets joined and not yet settled,",
              "returned or forfeited: in `vault_usdc`, outside `total_assets`."
            ],
            "type": "u64"
          },
          {
            "name": "protocolSharesAccrued",
            "docs": [
              "Protocol shares of settled and forfeited beacon tickets, not yet claimed."
            ],
            "type": "u64"
          },
          {
            "name": "appSharesOwed",
            "docs": [
              "`Σ Integrator.app_shares_accrued`."
            ],
            "type": "u64"
          },
          {
            "name": "beaconReturnsOwed",
            "docs": [
              "Ticket prices of refunded rounds' tickets not yet returned."
            ],
            "type": "u64"
          },
          {
            "name": "roundsForfeited",
            "docs": [
              "Rounds `expire_round` has forfeited, ever."
            ],
            "type": "u64"
          },
          {
            "name": "forfeitsWithheld",
            "docs": [
              "The expiries a withheld draw may explain: every forfeiture but one of",
              "a round never requested whose request the program looked for and did",
              "not find (`RoundExpired`'s `!requested && checked && !request_found`,",
              "the keepers' failure), and every round `expire_round` refunded because",
              "its entropy was never recorded and SlotHashes no longer proves it",
              "(`RoundExpired.refunded`). A durable count, so that an alarm never has",
              "to infer a withheld draw from transaction history it could not read."
            ],
            "type": "u64"
          },
          {
            "name": "ticketForfeitsWithheld",
            "docs": [
              "The direct expiries a withheld draw may explain, by the same rule as",
              "`forfeits_withheld` (`TicketExpired`'s `requested || request_found ||",
              "!checked`, every refund included), kept apart so that each path's",
              "alarm accounts for its own ordinals. Taken from the reserved tail."
            ],
            "type": "u64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                40
              ]
            }
          }
        ]
      }
    },
    {
      "name": "withdrawClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "atEpochId",
            "docs": [
              "The record the claim read the chain at."
            ],
            "type": "u64"
          },
          {
            "name": "assets",
            "type": "u64"
          },
          {
            "name": "closed",
            "docs": [
              "The request is fully served and closed."
            ],
            "type": "bool"
          },
          {
            "name": "delivered",
            "docs": [
              "What was owed reached the owner; otherwise it is parked on the request."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "withdrawRequest",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "rEntry",
            "docs": [
              "Chain indices at entry, copied from the entry record by the first claim; 0 before."
            ],
            "type": "u128"
          },
          {
            "name": "vEntry",
            "type": "u128"
          },
          {
            "name": "paid",
            "docs": [
              "Assets already paid by earlier partial claims."
            ],
            "type": "u64"
          },
          {
            "name": "chainId",
            "docs": [
              "The chain the request entered, copied with the indices; every later",
              "claim must read a record of this chain. A split carries the request into",
              "the next chain: its remaining `shares` at indices `START`."
            ],
            "type": "u64"
          },
          {
            "name": "undelivered",
            "docs": [
              "Assets owed but not delivered: the owner's USDC account could not",
              "receive when a claim ran. Delivered by the next claim that can."
            ],
            "type": "u64"
          },
          {
            "name": "parked",
            "docs": [
              "Set by the final claim when it could not deliver: every record is",
              "released and only `undelivered` remains to hand over."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "withdrawRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "epochId",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "beaconOutcomeTag",
      "docs": [
        "Domain tag of a beacon ticket's outcome; equal to `fade_math::beacon::OUTCOME_TAG`."
      ],
      "type": "bytes",
      "value": "[70, 65, 68, 69, 47, 66, 69, 65, 67, 79, 78, 45, 79, 85, 84, 67, 79, 77, 69, 47, 118, 49]"
    },
    {
      "name": "beaconSeedTag",
      "docs": [
        "Domain tag of a round's ORAO seed; equal to `fade_math::beacon::SEED_TAG`."
      ],
      "type": "bytes",
      "value": "[70, 65, 68, 69, 47, 66, 69, 65, 67, 79, 78, 45, 83, 69, 69, 68, 47, 118, 49]"
    },
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "depositQueueSeed",
      "docs": [
        "Deposits queued for a strike; not part of the vault's assets yet."
      ],
      "type": "bytes",
      "value": "[100, 101, 112, 111, 115, 105, 116, 45, 113, 117, 101, 117, 101]"
    },
    {
      "name": "depositSeed",
      "docs": [
        "`[\"deposit\", epoch_id, owner]`."
      ],
      "type": "bytes",
      "value": "[100, 101, 112, 111, 115, 105, 116]"
    },
    {
      "name": "epochSeed",
      "docs": [
        "`[\"epoch\", epoch_id]`."
      ],
      "type": "bytes",
      "value": "[101, 112, 111, 99, 104]"
    },
    {
      "name": "integratorAuthoritySeed",
      "docs": [
        "The seed a program integrator derives its signing PDA with, under its own",
        "program id: `[\"fade-integrator\"]`. Only that program can sign for it."
      ],
      "type": "bytes",
      "value": "[102, 97, 100, 101, 45, 105, 110, 116, 101, 103, 114, 97, 116, 111, 114]"
    },
    {
      "name": "integratorSeed",
      "docs": [
        "`[\"integrator\", authority]`: keyed on the address that signs `open_ticket`."
      ],
      "type": "bytes",
      "value": "[105, 110, 116, 101, 103, 114, 97, 116, 111, 114]"
    },
    {
      "name": "maxRoundBatch",
      "docs": [
        "Most tickets one `settle_round_tickets` may name: one bit of its `wins`",
        "mask each (Spec 08 §13.5.7). Transaction size binds well below it."
      ],
      "type": "u8",
      "value": "32"
    },
    {
      "name": "maxRoundK",
      "docs": [
        "The most per-ticket caps a round may carry (Spec 08 §13.3). A program",
        "constant, so that raising `k` takes an upgrade behind the 72-hour",
        "timelock rather than a parameter change: Spec 09 §7 ties it to stronger",
        "randomness, itself an upgrade."
      ],
      "type": "u8",
      "value": "1"
    },
    {
      "name": "payableSeed",
      "docs": [
        "Assets struck withdrawals are owed, not yet claimed."
      ],
      "type": "bytes",
      "value": "[112, 97, 121, 97, 98, 108, 101]"
    },
    {
      "name": "payoutEscrowSeed",
      "docs": [
        "Payouts to a beneficiary that could not receive them at settlement."
      ],
      "type": "bytes",
      "value": "[112, 97, 121, 111, 117, 116, 45, 101, 115, 99, 114, 111, 119]"
    },
    {
      "name": "payoutTableSeed",
      "docs": [
        "`[\"payout-table\", hash]`: a payout table stored once, referenced by beacon tickets."
      ],
      "type": "bytes",
      "value": "[112, 97, 121, 111, 117, 116, 45, 116, 97, 98, 108, 101]"
    },
    {
      "name": "payoutTableTag",
      "docs": [
        "Domain tag of a payout table's hash (Spec 08 §13.2.1); equal to",
        "`fade_math::beacon::PAYOUT_TABLE_TAG`."
      ],
      "type": "bytes",
      "value": "[70, 65, 68, 69, 47, 80, 65, 89, 79, 85, 84, 45, 84, 65, 66, 76, 69, 47, 118, 49]"
    },
    {
      "name": "queueSeed",
      "docs": [
        "The liquidity-provider side's state; its lamports above rent are the strike fund."
      ],
      "type": "bytes",
      "value": "[113, 117, 101, 117, 101]"
    },
    {
      "name": "refundOutcome",
      "docs": [
        "`Ticket.outcome` of a refund parked in `payout_escrow`: no payout table",
        "holds this index (32 outcomes at most), so a `PayoutPending` ticket",
        "carrying it is a refunded credit waiting for `claim_payout`, never a",
        "settlement. `u8::MAX`, written out so that the IDL and the generated",
        "clients carry the value."
      ],
      "type": "u8",
      "value": "255"
    },
    {
      "name": "roundSeed",
      "docs": [
        "`[\"round\", round_id]`, `round_id` little-endian `u64`."
      ],
      "type": "bytes",
      "value": "[114, 111, 117, 110, 100]"
    },
    {
      "name": "roundTicketSeed",
      "docs": [
        "`[\"round-ticket\", integrator, nonce]`: the nonce is the integrator's",
        "`next_nonce`, shared with the direct path."
      ],
      "type": "bytes",
      "value": "[114, 111, 117, 110, 100, 45, 116, 105, 99, 107, 101, 116]"
    },
    {
      "name": "roundVrfSeed",
      "docs": [
        "`[\"round-vrf\", round]`: the system-owned PDA that pays ORAO for a round's draw."
      ],
      "type": "bytes",
      "value": "[114, 111, 117, 110, 100, 45, 118, 114, 102]"
    },
    {
      "name": "shareClaimsSeed",
      "type": "bytes",
      "value": "[115, 104, 97, 114, 101, 45, 99, 108, 97, 105, 109, 115]"
    },
    {
      "name": "shareEscrowSeed",
      "type": "bytes",
      "value": "[115, 104, 97, 114, 101, 45, 101, 115, 99, 114, 111, 119]"
    },
    {
      "name": "shareMintSeed",
      "type": "bytes",
      "value": "[115, 104, 97, 114, 101, 115]"
    },
    {
      "name": "sponsorshipSeed",
      "docs": [
        "`[\"sponsorship\", round, sponsor]`."
      ],
      "type": "bytes",
      "value": "[115, 112, 111, 110, 115, 111, 114, 115, 104, 105, 112]"
    },
    {
      "name": "ticketSeed",
      "docs": [
        "`[\"ticket\", integrator, nonce]`."
      ],
      "type": "bytes",
      "value": "[116, 105, 99, 107, 101, 116]"
    },
    {
      "name": "usdcVaultSeed",
      "docs": [
        "The vault's USDC: backs every open ticket."
      ],
      "type": "bytes",
      "value": "[117, 115, 100, 99, 45, 118, 97, 117, 108, 116]"
    },
    {
      "name": "vaultAuthoritySeed",
      "docs": [
        "Signs for every token account the vault owns. No data."
      ],
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116, 45, 97, 117, 116, 104, 111, 114, 105, 116, 121]"
    },
    {
      "name": "vaultSeed",
      "docs": [
        "The ticket side's state."
      ],
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    },
    {
      "name": "vrfPayerSeed",
      "docs": [
        "`[\"vrf-payer\", ticket]`: the system-owned PDA that pays ORAO."
      ],
      "type": "bytes",
      "value": "[118, 114, 102, 45, 112, 97, 121, 101, 114]"
    },
    {
      "name": "withdrawSeed",
      "docs": [
        "`[\"withdraw\", epoch_id, owner]`."
      ],
      "type": "bytes",
      "value": "[119, 105, 116, 104, 100, 114, 97, 119]"
    }
  ]
};
