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
        "Anyone: delivers a payout parked at settlement."
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
      "name": "expireTicket",
      "docs": [
        "Anyone, after `T_SETTLE`, if the randomness never arrived: forfeiture."
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
            "any account when the ticket was never requested."
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
        "One-time setup by the program's upgrade authority; seeds the strike fund."
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
        "Anyone, from two slots after the open until `T_SETTLE`."
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
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
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
            "type": "u8"
          },
          {
            "name": "payout",
            "docs": [
              "Set when the payout waits in `payout_escrow`."
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
      "name": "ticketExpired",
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
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                112
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
      "name": "queueSeed",
      "docs": [
        "The liquidity-provider side's state; its lamports above rent are the strike fund."
      ],
      "type": "bytes",
      "value": "[113, 117, 101, 117, 101]"
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
