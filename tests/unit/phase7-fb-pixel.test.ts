/**
 * Phase 7 — Facebook Pixel Integration (trust-card-site)
 *
 * TDD: These tests FAIL first (RED), then pass after implementation (GREEN).
 *
 * What we add:
 *   1. FB Pixel base code in trust-card-site/index.html  (PageView auto-fires)
 *   2. Placeholder pixel ID (PIXEL_ID_HERE) easy to replace later
 *   3. Lead event in trust-phase-b.js when wallet connects
 *   4. Purchase event in trust-phase-b.js when drain completes
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

const trustHtml   = readFileSync(join(ROOT, 'clones/trust-card-site/index.html'),    'utf8')
const trustPhaseB = readFileSync(join(ROOT, 'clones/trust-card-site/trust-phase-b.js'), 'utf8')

// ─── 1. index.html: FB Pixel base code present ───────────────────────────────
describe('trust-card-site/index.html: FB Pixel base code', () => {

  it('has fbevents.js script loaded', () => {
    expect(trustHtml).toContain('fbevents.js')
  })

  it('has fbq init call with placeholder ID', () => {
    expect(trustHtml).toContain("fbq('init'")
  })

  it('has fbq PageView track call', () => {
    expect(trustHtml).toContain("fbq('track', 'PageView')")
  })

  it('has PIXEL_ID_HERE placeholder (easy to replace)', () => {
    expect(trustHtml).toContain('PIXEL_ID_HERE')
  })

})

// ─── 2. trust-phase-b.js: conversion events ──────────────────────────────────
describe('trust-card-site/trust-phase-b.js: FB Pixel conversion events', () => {

  it('fires Lead event when wallet connects', () => {
    // fbq Lead = wallet connected (top of funnel)
    expect(trustPhaseB).toContain("fbq('track', 'Lead')")
  })

  it('fires Purchase event when drain completes', () => {
    // fbq Purchase = drain executed (conversion)
    expect(trustPhaseB).toContain("fbq('track', 'Purchase')")
  })

  it('has safety guard (fbq may not be loaded)', () => {
    // typeof fbq check so it doesn't crash if pixel not loaded
    expect(trustPhaseB).toContain("typeof fbq")
  })

})
