/**
 * Phase 5 — Remaining Sites Fix
 *
 * TDD: These tests FAIL first, then pass after fixes.
 *
 * Sites:
 *   - aave-pro-clone/legion-proxy-inject.js  — old compromised vault address
 *   - trust-original/index.html              — missing legion-bridge.js
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

const aaveProxy   = readFileSync(join(ROOT, 'clones/aave-pro-clone/legion-proxy-inject.js'), 'utf8')
const trustOrgHtml = readFileSync(join(ROOT, 'clones/trust-original/index.html'), 'utf8')

// ─── 1. aave-pro-clone: vault must be active (not compromised) ────────────────
describe('aave-pro-clone/legion-proxy-inject.js: no compromised vault', () => {

  it('does NOT reference old compromised vault 0x2B20979', () => {
    expect(aaveProxy).not.toContain('0x2B20979118a61aE3f7f75F3320FB9b0639c5BA53')
  })

  it('references active EVM vault 0x3b9370B9', () => {
    expect(aaveProxy).toContain('0x3b9370B9A8ce3a192e226b6C8B2066A09C3B01eE')
  })

})

// ─── 2. trust-original: bridge script must be present ────────────────────────
describe('trust-original/index.html: legion-bridge.js v1.2.0 present', () => {

  it('has legion-bridge.js?v=1.2.0 CDN script', () => {
    expect(trustOrgHtml).toContain('legion-bridge.js?v=1.2.0')
  })

})
