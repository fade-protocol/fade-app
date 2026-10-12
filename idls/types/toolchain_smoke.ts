/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/toolchain_smoke.json`.
 */
export type ToolchainSmoke = {
  "address": "3FLR2XiNRr4WYT8qeac3zu2Xeo6qGvAirtdH9ZNhKC7T",
  "metadata": {
    "name": "toolchainSmoke",
    "version": "0.0.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "fundPda",
      "discriminator": [
        26,
        233,
        212,
        23,
        254,
        134,
        112,
        251
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
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
                "path": "payer"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
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
      "name": "oraoRequest",
      "discriminator": [
        204,
        248,
        211,
        47,
        136,
        42,
        228,
        61
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
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
                "path": "payer"
              }
            ]
          }
        },
        {
          "name": "networkState",
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
              "kind": "account",
              "path": "oraoProgram"
            }
          }
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "request",
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
                  114,
                  97,
                  110,
                  100,
                  111,
                  109,
                  110,
                  101,
                  115,
                  115,
                  45,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "seed"
              }
            ],
            "program": {
              "kind": "account",
              "path": "oraoProgram"
            }
          }
        },
        {
          "name": "oraoProgram",
          "address": "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "pdaTransfer",
      "discriminator": [
        99,
        148,
        176,
        195,
        55,
        36,
        204,
        52
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
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
                "path": "payer"
              }
            ]
          }
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
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
      "name": "ping",
      "discriminator": [
        173,
        0,
        94,
        236,
        73,
        133,
        225,
        153
      ],
      "accounts": [
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
    }
  ],
  "events": [
    {
      "name": "pinged",
      "discriminator": [
        50,
        38,
        24,
        188,
        75,
        109,
        130,
        119
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "slotHashesUnreadable",
      "msg": "SlotHashes sysvar could not be parsed"
    },
    {
      "code": 6001,
      "name": "networkStateUnreadable",
      "msg": "ORAO network state could not be parsed"
    },
    {
      "code": 6002,
      "name": "treasuryMismatch",
      "msg": "treasury does not match ORAO network state"
    }
  ],
  "types": [
    {
      "name": "pinged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "currentSlot",
            "type": "u64"
          },
          {
            "name": "latestSlot",
            "type": "u64"
          },
          {
            "name": "latestHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "vrfPayerSeed",
      "type": "bytes",
      "value": "[118, 114, 102, 45, 112, 97, 121, 101, 114]"
    }
  ]
};
