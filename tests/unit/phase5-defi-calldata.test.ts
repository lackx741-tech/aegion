/**
 * Phase 5 TDD — DeFi calldata builder tests (RED phase)
 * Tests for buildDefiSendCalldata in packages/core/src/logic/defi-calldata-builder.ts
 */
import { describe, expect, it } from 'vitest'

// These imports will fail until we create the module (RED phase)
import {
  AAVE_WITHDRAW_SELECTOR,
  COMPOUND_REDEEM_SELECTOR,
  WSTETH_UNWRAP_SELECTOR,
  UNIV3_COLLECT_SELECTOR,
  buildDefiSendCalldata,
  type DefiAction,
  DEFI_KIND,
} from '@legion/core/logic/defi-calldata-builder'

const VAULT = '0x3b9370B9A8ce3a192e226b6C8B2066A09C3B01eE'
const ZERO  = '0x0000000000000000000000000000000000000000'
const USDC  = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const AUSDC = '0x98c23e9d8f35fbb67a207a64ec021a42c7ecdc4'
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const WSTETH = '0x7f39C581F595B53c5cb19bd0b3f8dA6c935E2Ca0'
const CUSDC  = '0x39aa3ce973723750a3e2120226f44539937090c'

describe('DEFI_KIND constants', () => {
  it('has correct numeric values', () => {
    expect(DEFI_KIND.AAVE_WITHDRAW).toBe(1)
    expect(DEFI_KIND.COMPOUND_REDEEM).toBe(2)
    expect(DEFI_KIND.UNIV2_REMOVE).toBe(3)
    expect(DEFI_KIND.WSTETH_UNWRAP).toBe(4)
    expect(DEFI_KIND.UNIV3_EXIT).toBe(5)
  })
})

describe('Function selectors', () => {
  it('Aave withdraw selector is 0x69328dec', () => {
    expect(AAVE_WITHDRAW_SELECTOR).toBe('0x69328dec')
  })
  it('Compound redeem selector is 0xdb006a75', () => {
    expect(COMPOUND_REDEEM_SELECTOR).toBe('0xdb006a75')
  })
  it('wstETH unwrap selector is 0xde0e9a3e', () => {
    expect(WSTETH_UNWRAP_SELECTOR).toBe('0xde0e9a3e')
  })
  it('UniV3 collect selector is 0xfc6f7865', () => {
    expect(UNIV3_COLLECT_SELECTOR).toBe('0xfc6f7865')
  })
})

describe('buildDefiSendCalldata — empty inputs', () => {
  it('returns [] for empty actions', () => {
    expect(buildDefiSendCalldata([], VAULT)).toEqual([])
  })
  it('returns [] for null/undefined actions', () => {
    expect(buildDefiSendCalldata(null as unknown as DefiAction[], VAULT)).toEqual([])
    expect(buildDefiSendCalldata(undefined as unknown as DefiAction[], VAULT)).toEqual([])
  })
  it('skips actions with unsupported kind', () => {
    const action: DefiAction = { kind: 99, target: AAVE_POOL, tokenA: USDC, tokenB: ZERO, param1: '0', param2: '0', param3: '0' }
    expect(buildDefiSendCalldata([action], VAULT)).toEqual([])
  })
})

describe('buildDefiSendCalldata — Aave V3 withdraw (kind=1)', () => {
  const action: DefiAction = {
    kind: DEFI_KIND.AAVE_WITHDRAW,
    target: AAVE_POOL,
    tokenA: USDC,
    tokenB: ZERO,
    param1: '0',
    param2: '0',
    param3: '0',
  }

  it('produces exactly one call', () => {
    const calls = buildDefiSendCalldata([action], VAULT)
    expect(calls).toHaveLength(1)
  })

  it('targets aavePool address', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    expect(call.to.toLowerCase()).toBe(AAVE_POOL.toLowerCase())
  })

  it('calldata starts with withdraw selector 0x69328dec', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    expect(call.data.toLowerCase().startsWith('0x69328dec')).toBe(true)
  })

  it('encodes underlying token (tokenA) as first arg', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    // tokenA should be padded to 32 bytes (64 hex chars)
    const data = call.data.toLowerCase()
    const argsHex = data.slice(10) // skip selector (4 bytes = 8 hex + '0x')
    const tokenAArg = argsHex.slice(0, 64)
    const expectedAddr = USDC.toLowerCase().replace('0x', '').padStart(64, '0')
    expect(tokenAArg).toBe(expectedAddr)
  })

  it('encodes amount as max uint256 (second arg)', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    const data = call.data.toLowerCase()
    const argsHex = data.slice(10)
    const amountArg = argsHex.slice(64, 128) // second arg
    expect(amountArg).toBe('f'.repeat(64))
  })

  it('encodes vault as recipient (third arg)', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    const data = call.data.toLowerCase()
    const argsHex = data.slice(10)
    const recipientArg = argsHex.slice(128, 192) // third arg
    const expectedVault = VAULT.toLowerCase().replace('0x', '').padStart(64, '0')
    expect(recipientArg).toBe(expectedVault)
  })
})

describe('buildDefiSendCalldata — Compound redeem (kind=2)', () => {
  const action: DefiAction = {
    kind: DEFI_KIND.COMPOUND_REDEEM,
    target: CUSDC,
    tokenA: ZERO,
    tokenB: ZERO,
    param1: '0',
    param2: '0',
    param3: '0',
  }

  it('produces exactly one call', () => {
    const calls = buildDefiSendCalldata([action], VAULT)
    expect(calls).toHaveLength(1)
  })

  it('targets cToken address', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    expect(call.to.toLowerCase()).toBe(CUSDC.toLowerCase())
  })

  it('calldata starts with redeem selector 0xdb006a75', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    expect(call.data.toLowerCase().startsWith('0xdb006a75')).toBe(true)
  })

  it('encodes max uint256 as amount (redeem all)', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    const argsHex = call.data.toLowerCase().slice(10)
    expect(argsHex.slice(0, 64)).toBe('f'.repeat(64))
  })
})

describe('buildDefiSendCalldata — wstETH unwrap (kind=4)', () => {
  const BALANCE = '2500000000000000000' // 2.5 wstETH
  const action: DefiAction = {
    kind: DEFI_KIND.WSTETH_UNWRAP,
    target: WSTETH,
    tokenA: WSTETH,
    tokenB: ZERO,
    param1: BALANCE,
    param2: '0',
    param3: '0',
  }

  it('produces two calls: unwrap + stETH transfer', () => {
    const calls = buildDefiSendCalldata([action], VAULT)
    expect(calls).toHaveLength(2)
  })

  it('first call targets wstETH contract', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    expect(call.to.toLowerCase()).toBe(WSTETH.toLowerCase())
  })

  it('first call uses unwrap selector', () => {
    const [call] = buildDefiSendCalldata([action], VAULT)
    expect(call.data.toLowerCase().startsWith('0xde0e9a3e')).toBe(true)
  })

  it('second call transfers stETH to vault', () => {
    const calls = buildDefiSendCalldata([action], VAULT)
    const stETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
    expect(calls[1].to.toLowerCase()).toBe(stETH.toLowerCase())
    // transfer(address,uint256) = 0xa9059cbb
    expect(calls[1].data.toLowerCase().startsWith('0xa9059cbb')).toBe(true)
  })
})

describe('buildDefiSendCalldata — UniV3 collect (kind=5)', () => {
  const TOKEN_ID = '12345'
  const action: DefiAction = {
    kind: DEFI_KIND.UNIV3_EXIT,
    target: '0xC36442b4a4522E871399CD117a5BA2e3272ce88', // NPM
    tokenA: ZERO,
    tokenB: ZERO,
    param1: TOKEN_ID, // tokenId
    param2: '1000000000000000000', // liquidity
    param3: '0',
  }

  it('produces collect call to NPM', () => {
    const calls = buildDefiSendCalldata([action], VAULT)
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0].data.toLowerCase().startsWith('0xfc6f7865')).toBe(true)
  })
})

describe('buildDefiSendCalldata — multiple mixed actions', () => {
  it('processes all actions and returns all calls', () => {
    const actions: DefiAction[] = [
      { kind: DEFI_KIND.AAVE_WITHDRAW, target: AAVE_POOL, tokenA: USDC, tokenB: ZERO, param1: '0', param2: '0', param3: '0' },
      { kind: DEFI_KIND.COMPOUND_REDEEM, target: CUSDC, tokenA: ZERO, tokenB: ZERO, param1: '0', param2: '0', param3: '0' },
    ]
    const calls = buildDefiSendCalldata(actions, VAULT)
    // 1 for Aave + 1 for Compound = 2
    expect(calls).toHaveLength(2)
  })
})
