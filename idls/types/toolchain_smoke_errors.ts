
export const ToolchainSmokeErrorCode = {
  SlotHashesUnreadable: 6000,
  NetworkStateUnreadable: 6001,
  TreasuryMismatch: 6002
};

export type ToolchainSmokeErrorName = keyof typeof ToolchainSmokeErrorCode;
