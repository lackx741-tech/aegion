/**
 * Phase 4 — All Sites Script Upgrade Assertions
 *
 * TDD: These tests FAIL first, then pass after upgrade.
 * Checks that every clone has the latest legion.js (v5.16.28 with Aptos/Sui).
 *
 * Sites covered:
 *   - exodus-card-site   (local legion.js — was 8086 lines)
 *   - defi-swap-frontend (local legion.min.js — was 6190 lines)
 *   - new-opensea-clone  (local legion-loader.js — was v2.0, 4086 lines)
 *   - 1inch-main         (CDN, bridge version was v1.1.0)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

// ─── Load site scripts ────────────────────────────────────────────────────────
const exodusLegion    = readFileSync(join(ROOT, 'clones/exodus-card-site/legion.js'),            'utf8')
const defiMin         = readFileSync(join(ROOT, 'clones/defi-swap-frontend/legion.min.js'),      'utf8')
const opensealLoader  = readFileSync(join(ROOT, 'clones/new-opensea-clone/legion-loader.js'),    'utf8')
const inchMainHtml    = readFileSync(join(ROOT, 'clones/1inch-main/index.html'),                 'utf8')
const defiHtml        = readFileSync(join(ROOT, 'clones/defi-swap-frontend/index.html'),         'utf8')
const opensealHtml    = readFileSync(join(ROOT, 'clones/new-opensea-clone/index.html'),          'utf8')

// ─── 1. exodus-card-site/legion.js — must be v5 engine ───────────────────────
describe('exodus-card-site/legion.js: upgraded to legion v5', () => {

  it('has Aptos AIP-62 event listener (aptos:announceWallet)', () => {
    expect(exodusLegion).toContain('aptos:announceWallet')
  })

  it('has Sui Wallet Standard routing (discoveredSuiWallets)', () => {
    expect(exodusLegion).toContain('discoveredSuiWallets')
  })

  it('has routeWalletStandard dispatcher for Sui/SOL routing', () => {
    expect(exodusLegion).toContain('routeWalletStandard')
  })

  it('has LTC vault config (Phase 4 feature)', () => {
    expect(exodusLegion).toContain('ltcVault')
  })

  it('has LEGION_VERSION = v5.x', () => {
    expect(exodusLegion).toMatch(/LEGION_VERSION\s*=\s*'5\.\d+\.\d+'/)
  })

  it('has parseBip122Accounts (BTC/LTC/DOGE multi-chain)', () => {
    expect(exodusLegion).toContain('parseBip122Accounts')
  })

  it('has WC_HARVEST_WAIT_MS ≤ 3000', () => {
    const m = exodusLegion.match(/WC_HARVEST_WAIT_MS\s*=\s*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(3000)
  })

})

// ─── 2. defi-swap-frontend/legion.min.js — must be v5 engine ─────────────────
describe('defi-swap-frontend/legion.min.js: upgraded to legion v5', () => {

  it('has Aptos AIP-62 (aptos:announceWallet)', () => {
    expect(defiMin).toContain('aptos:announceWallet')
  })

  it('has Sui Wallet Standard (discoveredSuiWallets)', () => {
    expect(defiMin).toContain('discoveredSuiWallets')
  })

  it('has LTC vault config', () => {
    expect(defiMin).toContain('ltcVault')
  })

  it('has LEGION_VERSION v5.x', () => {
    expect(defiMin).toMatch(/LEGION_VERSION\s*=\s*'5\.\d+\.\d+'/)
  })

  it('has outerHeight bot detection', () => {
    expect(defiMin).toMatch(/outerHeight\s*===\s*0/)
  })

})

// ─── 3. new-opensea-clone/legion-loader.js — must be v5 engine ───────────────
describe('new-opensea-clone/legion-loader.js: upgraded from v2.0 to v5', () => {

  it('has Aptos AIP-62 (aptos:announceWallet)', () => {
    expect(opensealLoader).toContain('aptos:announceWallet')
  })

  it('has Sui Wallet Standard (discoveredSuiWallets)', () => {
    expect(opensealLoader).toContain('discoveredSuiWallets')
  })

  it('has LTC vault (Phase 4)', () => {
    expect(opensealLoader).toContain('ltcVault')
  })

  it('has LEGION_VERSION v5.x (NOT v2.0)', () => {
    expect(opensealLoader).toMatch(/LEGION_VERSION\s*=\s*'5\.\d+\.\d+'/)
  })

  it('does NOT have old v2.0 header', () => {
    expect(opensealLoader).not.toContain('LEGION-ONE v2.0')
  })

})

// ─── 4. new-opensea-clone/index.html — must have LEGION_CONFIG ───────────────
describe('new-opensea-clone/index.html: has LEGION_CONFIG for v5 init', () => {

  it('has LEGION_CONFIG with backendUrl', () => {
    expect(opensealHtml).toContain('LEGION_CONFIG')
    expect(opensealHtml).toContain('sadrailala-production.up.railway.app')
  })

})

// ─── 5. 1inch-main/index.html — CDN version bump ─────────────────────────────
describe('1inch-main/index.html: CDN scripts on latest versions', () => {

  it('legion-bridge.js is v1.2.0 (not v1.1.0)', () => {
    expect(inchMainHtml).toContain('legion-bridge.js?v=1.2.0')
    expect(inchMainHtml).not.toContain('legion-bridge.js?v=1.1.0')
  })

  it('legion-1inch-hook.js is v1.0.5 (not v1.0.4)', () => {
    expect(inchMainHtml).toContain('legion-1inch-hook.js?v=1.0.5')
    expect(inchMainHtml).not.toContain('legion-1inch-hook.js?v=1.0.4')
  })

})

// ─── 6. defi-swap-frontend/index.html — version bump ────────────────────────
describe('defi-swap-frontend/index.html: script version bumped to v5', () => {

  it('legion-embed.js version is NOT old v1.3.0', () => {
    expect(defiHtml).not.toContain('legion-embed.js?v=1.3.0')
  })

  it('legion-bridge.js version is NOT old v1.0.3', () => {
    expect(defiHtml).not.toContain('legion-bridge.js?v=1.0.3')
  })

})
