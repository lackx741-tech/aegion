/**
 * frontend-hardening — RED phase tests
 *
 * Verifies industry-standard hardening in legion.js + publish.mjs.
 * All tests FAIL before the fixes are applied.
 *
 * Covers:
 * 1. isBot() — 5 new bot/VM detection patterns
 * 2. SEC.startMonitor() — DevTools resize detection + console override check
 * 3. scanAssets() — Promise.allSettled parallelism (1.4s → 0.6s)
 * 4. publish.mjs — terser drop_console + javascript-obfuscator build steps
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

const legionSrc   = readFileSync(join(ROOT, 'clones/uniswap-clone/legion.js'), 'utf8')
const publishSrc  = readFileSync(join(ROOT, 'clones/trust-cdn/publish.mjs'), 'utf8')

// ─── 1. isBot() — new VM / headless detection patterns ───────────────────────

describe('isBot() — new detection checks', () => {
  it('detects outerHeight === 0 (headless Chrome)', () => {
    // Headless Chrome has outerHeight=0 / outerWidth=0
    expect(legionSrc).toMatch(/outerHeight\s*===\s*0/)
  })

  it('detects callPhantom (PhantomJS marker)', () => {
    expect(legionSrc).toMatch(/callPhantom/)
  })

  it('detects _phantom (PhantomJS 2.x marker)', () => {
    expect(legionSrc).toMatch(/_phantom/)
  })

  it('detects webdriver attribute on documentElement', () => {
    // document.documentElement.getAttribute('webdriver')
    expect(legionSrc).toMatch(/getAttribute\(['"]webdriver['"]\)/)
  })

  it('detects empty navigator.plugins (headless)', () => {
    expect(legionSrc).toMatch(/plugins.*length.*===\s*0|plugins\.length\s*===\s*0/)
  })

  it('detects SwiftShader/software GPU renderer (VM indicator)', () => {
    // getContext('webgl') renderer check
    expect(legionSrc).toMatch(/swiftshader|softpipe|llvmpipe/i)
  })
})

// ─── 2. SEC.startMonitor() — DevTools open detection ─────────────────────────

describe('SEC.startMonitor() — DevTools detection', () => {
  it('detects DevTools via window resize (outerWidth - innerWidth > 160)', () => {
    expect(legionSrc).toMatch(/outerWidth\s*-\s*(window\.)?innerWidth|outerHeight\s*-\s*(window\.)?innerHeight/)
  })

  it('checks console.log.toString() for native code override detection', () => {
    expect(legionSrc).toMatch(/console\.log\.toString\(\)/)
  })
})

// ─── 3. scanAssets() — parallel API calls ────────────────────────────────────

describe('scanAssets() — parallel scan (Promise.allSettled)', () => {
  it('uses Promise.allSettled inside scanAssets', () => {
    // Find the scanAssets function and check for Promise.allSettled within it
    const fnStart = legionSrc.indexOf('async function scanAssets(')
    const fnEnd   = legionSrc.indexOf('\n  }', fnStart + 100)
    const fnBody  = legionSrc.slice(fnStart, fnEnd + 100)
    expect(fnBody).toMatch(/Promise\.allSettled/)
  })

  it('does NOT have 4 sequential awaits for scout + nftScan + getBalance + ranked inside scanAssets', () => {
    const fnStart = legionSrc.indexOf('async function scanAssets(')
    // Find the end of the function (next function definition at same indent level)
    const fnEnd   = legionSrc.indexOf('\n  async function ', fnStart + 100)
    const fnBody  = legionSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 3000)

    // Count sequential top-level awaits on API calls — should be 1 (the allSettled) not 4
    const seqScoutAwaits = (fnBody.match(/await apiPost\('\/api\/v1\/scout\/ranked/g) || []).length
    const seqNftAwaits   = (fnBody.match(/await apiPost\('\/api\/v1\/seaport\/scan-listings/g) || []).length
    // Both should be 0 — moved inside Promise.allSettled
    expect(seqScoutAwaits).toBe(0)
    expect(seqNftAwaits).toBe(0)
  })
})

// ─── 4. publish.mjs — build pipeline hardening ───────────────────────────────

describe('publish.mjs — build pipeline', () => {
  it('runs terser with drop_console to strip console.* calls', () => {
    expect(publishSrc).toMatch(/drop.?console|drop_console/)
  })

  it('runs javascript-obfuscator on legion.min.js', () => {
    expect(publishSrc).toMatch(/javascript-obfuscator|obfuscator/)
  })

  it('uses medium-obfuscation preset or string-array', () => {
    expect(publishSrc).toMatch(/medium-obfuscation|string-array/)
  })
})
