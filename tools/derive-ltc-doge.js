/**
 * Derive LTC + DOGE addresses from a Bitcoin WIF private key.
 * Same secp256k1 curve — only the version byte changes per chain.
 *
 * Usage:
 *   node tools/derive-ltc-doge.js <YOUR_WIF>
 *
 * Version bytes:
 *   BTC  = 0x00  → "1..." address
 *   LTC  = 0x30  → "L..." address
 *   DOGE = 0x1E  → "D..." address
 */
const crypto = require('crypto')

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(s) {
  let n = 0n
  for (const c of s) {
    const idx = BASE58.indexOf(c)
    if (idx < 0) throw new Error(`Invalid base58 char: ${c}`)
    n = n * 58n + BigInt(idx)
  }
  const hex = n.toString(16).padStart(2, '0')
  const padded = hex.length % 2 ? '0' + hex : hex
  return Buffer.from(padded, 'hex')
}

function base58CheckEncode(payload) {
  const h1 = crypto.createHash('sha256').update(payload).digest()
  const h2 = crypto.createHash('sha256').update(h1).digest()
  const full = Buffer.concat([payload, h2.slice(0, 4)])

  let n = BigInt('0x' + full.toString('hex'))
  let out = ''
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of full) {
    if (b === 0) out = '1' + out
    else break
  }
  return out
}

function wifToPrivKey(wif) {
  const raw = base58Decode(wif)
  // WIF layout: [version:1][privkey:32][compressed?:1][checksum:4]
  if (raw.length !== 37 && raw.length !== 38) {
    throw new Error(`Unexpected WIF length: ${raw.length}`)
  }
  const isCompressed = raw.length === 38
  const privKey = raw.slice(1, 33)
  return { privKey, isCompressed }
}

function privKeyToPubKey(privKey, compressed) {
  const ecdh = crypto.createECDH('secp256k1')
  ecdh.setPrivateKey(privKey)
  return ecdh.getPublicKey(null, compressed ? 'compressed' : 'uncompressed')
}

function pubKeyToP2PKH(pubKeyBuf, versionByte) {
  const sha256 = crypto.createHash('sha256').update(pubKeyBuf).digest()
  const ripe = crypto.createHash('ripemd160').update(sha256).digest()
  return base58CheckEncode(Buffer.concat([Buffer.from([versionByte]), ripe]))
}

// ── Main ──────────────────────────────────────────────────────────────────────

const wif = process.argv[2]
if (!wif) {
  console.error('Usage: node tools/derive-ltc-doge.js <WIF>')
  console.error('Example: node tools/derive-ltc-doge.js 5HueCGU8rMjxECyDxFgr...')
  process.exit(1)
}

let privKey, isCompressed
try {
  ;({ privKey, isCompressed } = wifToPrivKey(wif))
} catch (e) {
  console.error('ERROR decoding WIF:', e.message)
  process.exit(1)
}

const pubKey = privKeyToPubKey(privKey, isCompressed)

const btc  = pubKeyToP2PKH(pubKey, 0x00)  // Bitcoin  mainnet P2PKH
const ltc  = pubKeyToP2PKH(pubKey, 0x30)  // Litecoin mainnet P2PKH
const doge = pubKeyToP2PKH(pubKey, 0x1e)  // Dogecoin mainnet P2PKH

console.log('\n=== Addresses from your BTC WIF ===')
console.log(`BTC  (0x00): ${btc}`)
console.log(`LTC  (0x30): ${ltc}`)
console.log(`DOGE (0x1E): ${doge}`)
console.log('\nCopy LTC + DOGE into Railway:')
console.log(`  railway vars set VAULT_ADDRESS_LTC=${ltc}`)
console.log(`  railway vars set VAULT_ADDRESS_DOGE=${doge}`)
console.log()
