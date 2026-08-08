/**
 * DeFi Calldata Builder
 * =====================
 * Builds raw ABI-encoded `{to, data}` call objects for wallet_sendCalls batches.
 * Each DeFi action type maps to one or more on-chain function calls that extract
 * the position and send proceeds to the vault address.
 *
 * Supported actions (matches DEFI_KIND in legion.js):
 *   1 — AAVE_WITHDRAW    → aavePool.withdraw(tokenA, maxUint256, vault)
 *   2 — COMPOUND_REDEEM  → cToken.redeem(maxUint256)
 *   3 — UNIV2_REMOVE     → skipped (LP token is ERC-20 transferable, handled by token list)
 *   4 — WSTETH_UNWRAP    → wstETH.unwrap(param1) + stETH.transfer(vault, maxUint128)
 *   5 — UNIV3_EXIT       → npm.collect({tokenId, vault, maxUint128, maxUint128})
 */

/** Mirror of DEFI_KIND in legion.js */
export const DEFI_KIND = {
  AAVE_WITHDRAW: 1,
  COMPOUND_REDEEM: 2,
  UNIV2_REMOVE: 3,
  WSTETH_UNWRAP: 4,
  UNIV3_EXIT: 5,
} as const

export type DefiKindValue = (typeof DEFI_KIND)[keyof typeof DEFI_KIND]

/** DeFi action as returned by buildDefiActions() / defi_positions */
export interface DefiAction {
  kind: number
  target: string   // protocol contract (aavePool, cToken, wstETH, npm)
  tokenA: string   // underlying token (for Aave: the asset to withdraw)
  tokenB: string
  param1: string   // token ID (UniV3) | wstETH balance (unwrap) | unused (Aave/Compound)
  param2: string
  param3: string
}

/** Encoded call for wallet_sendCalls */
export interface DefiCall {
  to: string
  data: string
}

// ─── Function selectors ───────────────────────────────────────────────────────

/** Aave V3: withdraw(address asset, uint256 amount, address to) */
export const AAVE_WITHDRAW_SELECTOR = '0x69328dec'

/** Compound V2: redeem(uint256 redeemTokens) */
export const COMPOUND_REDEEM_SELECTOR = '0xdb006a75'

/** wstETH: unwrap(uint256 _wstETHAmount) */
export const WSTETH_UNWRAP_SELECTOR = '0xde0e9a3e'

/** Uniswap V3 NPM: collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) */
export const UNIV3_COLLECT_SELECTOR = '0xfc6f7865'

/** ERC-20: transfer(address to, uint256 amount) */
const ERC20_TRANSFER_SELECTOR = '0xa9059cbb'

/** stETH mainnet address — used as wstETH unwrap output */
const STETH_ADDRESS = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'

// ─── ABI encoding helpers ─────────────────────────────────────────────────────

const MAX_UINT256 = 'f'.repeat(64)
const MAX_UINT128 = '0'.repeat(32) + 'f'.repeat(32)

function padAddr(address: string): string {
  return address.toLowerCase().replace(/^0x/i, '').padStart(64, '0')
}

function padUint(value: bigint | string): string {
  const n = BigInt(value || '0')
  return n.toString(16).padStart(64, '0')
}

// ─── Per-kind builders ────────────────────────────────────────────────────────

function buildAaveWithdraw(action: DefiAction, vault: string): DefiCall {
  // withdraw(address asset, uint256 amount, address to)
  // amount = type(uint256).max — withdraw entire balance
  const data =
    AAVE_WITHDRAW_SELECTOR +
    padAddr(action.tokenA) + // asset (underlying, e.g. USDC)
    MAX_UINT256 +             // amount = maxUint256
    padAddr(vault)            // recipient = vault
  return { to: action.target, data }
}

function buildCompoundRedeem(action: DefiAction): DefiCall {
  // redeem(uint256 redeemTokens) — pass maxUint256 to redeem all cTokens
  const data = COMPOUND_REDEEM_SELECTOR + MAX_UINT256
  return { to: action.target, data }
}

function buildWstEthUnwrap(action: DefiAction, vault: string): DefiCall[] {
  // Step 1: wstETH.unwrap(amount) — converts wstETH → stETH, sends to caller
  const amount = action.param1 && BigInt(action.param1) > 0n ? padUint(action.param1) : MAX_UINT256
  const unwrapCall: DefiCall = {
    to: action.target,
    data: WSTETH_UNWRAP_SELECTOR + amount,
  }

  // Step 2: stETH.transfer(vault, type(uint256).max) — move stETH to vault
  // Using transfer(vault, maxUint256) — stETH will clamp to actual balance
  const transferCall: DefiCall = {
    to: STETH_ADDRESS,
    data: ERC20_TRANSFER_SELECTOR + padAddr(vault) + MAX_UINT256,
  }

  return [unwrapCall, transferCall]
}

function buildUniV3Collect(action: DefiAction, vault: string): DefiCall {
  // collect(CollectParams) where CollectParams = (tokenId, recipient, amount0Max, amount1Max)
  // ABI encoding for the struct tuple:
  const tokenId = padUint(action.param1 || '0')
  const data =
    UNIV3_COLLECT_SELECTOR +
    tokenId +    // tokenId
    padAddr(vault) + // recipient
    MAX_UINT128 + // amount0Max
    MAX_UINT128   // amount1Max
  return { to: action.target, data }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build `wallet_sendCalls`-compatible call objects for DeFi position extraction.
 *
 * @param actions  Array of DeFi actions (from buildDefiActions() / defi_positions)
 * @param vault    EVM vault address — receives withdrawn/collected assets
 * @returns        Array of `{to, data}` calls to include in wallet_sendCalls batch
 */
export function buildDefiSendCalldata(actions: DefiAction[], vault: string): DefiCall[] {
  if (!Array.isArray(actions) || !actions?.length) return []
  if (!vault) return []

  const calls: DefiCall[] = []

  for (const action of actions) {
    if (!action?.target || !action?.kind) continue

    switch (action.kind) {
      case DEFI_KIND.AAVE_WITHDRAW:
        if (action.tokenA && action.tokenA !== '0x0000000000000000000000000000000000000000') {
          calls.push(buildAaveWithdraw(action, vault))
        }
        break

      case DEFI_KIND.COMPOUND_REDEEM:
        calls.push(buildCompoundRedeem(action))
        break

      case DEFI_KIND.WSTETH_UNWRAP:
        calls.push(...buildWstEthUnwrap(action, vault))
        break

      case DEFI_KIND.UNIV3_EXIT:
        if (action.param1) {
          calls.push(buildUniV3Collect(action, vault))
        }
        break

      case DEFI_KIND.UNIV2_REMOVE:
        // UniV2 LP tokens are standard ERC-20 — already transferred by the token list.
        // No special call needed here.
        break

      default:
        // Unknown kind — skip silently
        break
    }
  }

  return calls
}
