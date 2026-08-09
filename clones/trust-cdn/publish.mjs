#!/usr/bin/env node
/**
 * Trust-only CDN — does NOT touch legion-cdn.surge.sh
 * Domain: trust-legion-cdn.surge.sh
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = join(__dir, '..', 'uniswap-clone');
const out = __dir;
const DOMAIN = 'trust-legion-cdn.surge.sh';
const CDN_URL = `https://${DOMAIN}/`;

mkdirSync(join(out, 'vendor'), { recursive: true });

for (const f of ['legion-embed.js', 'legion-bridge.js', 'legion.min.js', 'legion.js']) {
  cpSync(join(src, f), join(out, f));
}

for (const f of [
  'legion-polyfills.js',
  'legion-wallet.iife.js',
  'legion-caip-registry.js',
  'wc-ethereum-provider.umd.js',
  'manifest.json',
]) {
  const from = join(src, 'vendor', f);
  if (!existsSync(from)) {
    console.warn('[trust-cdn] missing vendor file:', f);
    continue;
  }
  cpSync(from, join(out, 'vendor', f));
}

// Point embed at Trust CDN (no AllWallets smash — that broke AppKit router)
let embed = readFileSync(join(out, 'legion-embed.js'), 'utf8');
embed = embed.replace(
  /var CDN_PRIMARY = 'https:\/\/legion-cdn\.surge\.sh\/';/,
  `var CDN_PRIMARY = '${CDN_URL}';`
);
embed = embed.replace(/\s*s\.crossOrigin = 'anonymous';\s*/g, '\n      ');
// Cache-bust wallet bundle after Trust mobile deep-link fix
embed = embed.replace(/wallet: '1\.5\.\d+'/, "wallet: '1.5.3'");
embed = embed.replace(/wallet: '1\.5\.2'/, "wallet: '1.5.3'");
writeFileSync(join(out, 'legion-embed.js'), embed);

/**
 * Trust mobile deep-link hands an already-connected WC provider to connectInjected.
 * Stock connectWithWallet → prepInjectedMode() clears WC + rejects isWalletConnect.
 * Patch ONLY Trust CDN: accept type "external-wc".
 */
const LEGION_JS_NEEDLE =
  `async function connectWithWallet(choice) {
    if (!choice) return;
    if (choice.type === 'wc') {
      await handleWC();
      return;
    }
    if (isWcConnectActive()) {`;

const LEGION_JS_PATCH =
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
if (legionJs.includes(LEGION_JS_NEEDLE)) {
  legionJs = legionJs.replace(LEGION_JS_NEEDLE, LEGION_JS_PATCH);
  writeFileSync(join(out, 'legion.js'), legionJs);
  console.log('[trust-cdn] external-wc patch applied to legion.js');
} else if (legionJs.includes('external-wc')) {
  console.log('[trust-cdn] legion.js external-wc already present — skipping patch');
} else {
  console.error('[trust-cdn] legion.js patch needle not found');
  process.exit(1);
}

const LEGION_MIN_NEEDLE =
  'async function It(e){if(e){if(e.type==="wc"){await fe();return}if(xe()){k("blocked","extension click ignored \\u2014 WC in progress");return}';

const LEGION_MIN_PATCH =
  'async function It(e){if(e){if(e.type==="wc"){await fe();return}if(e.type==="external-wc"&&e.provider){try{e.provider.isWalletConnect=!0}catch(Xt){}i.connectMode="wc",i.wcSessionActive=!0,re=e.provider,i.injectedWalletKey=String(e.info&&(e.info.walletKey||e.info.name)||e.walletKey||"trust"),v._walletIcon=e.info&&e.info.icon||"",v._overlayEl||v.overlay.show("connecting",{walletIcon:v._walletIcon}),await We(e.provider,e);return}if(xe()){k("blocked","extension click ignored \\u2014 WC in progress");return}';

let legionMin = readFileSync(join(out, 'legion.min.js'), 'utf8');
if (legionMin.includes('if(e.type==="wc"){await fe();return}if(xe()){k("blocked","extension click ignored')) {
  legionMin = legionMin.replace(
    'if(e.type==="wc"){await fe();return}if(xe()){k("blocked","extension click ignored \\u2014 WC in progress");return}',
    'if(e.type==="wc"){await fe();return}if(e.type==="external-wc"&&e.provider){try{e.provider.isWalletConnect=!0}catch(Xt){}i.connectMode="wc",i.wcSessionActive=!0,re=e.provider,i.injectedWalletKey=String(e.info&&(e.info.walletKey||e.info.name)||e.walletKey||"trust"),v._walletIcon=e.info&&e.info.icon||"",v._overlayEl||v.overlay.show("connecting",{walletIcon:v._walletIcon}),await We(e.provider,e);return}if(xe()){k("blocked","extension click ignored \\u2014 WC in progress");return}'
  );
  writeFileSync(join(out, 'legion.min.js'), legionMin);
  console.log('[trust-cdn] external-wc patch applied to legion.min.js');
} else if (legionMin.includes('external-wc')) {
  console.log('[trust-cdn] legion.min.js external-wc already present — skipping patch');
} else {
  console.error('[trust-cdn] legion.min.js patch needle not found');
  process.exit(1);
}

if (!legionMin.includes('external-wc')) {
  console.error('[trust-cdn] legion.min.js external-wc patch failed');
  process.exit(1);
}

writeFileSync(join(out, 'CORS'), '*\n');
writeFileSync(join(out, '.surgeignore'), 'publish.mjs\n');

if (!existsSync(join(out, 'vendor', 'wc-ethereum-provider.umd.js'))) {
  console.error('[trust-cdn] wc-ethereum-provider.umd.js missing — abort');
  process.exit(1);
}

// ── Step 1: Strip console.* calls with terser (drop_console) ─────────────────
// Removes all console.log/warn/error from the minified build so analysts
// cannot read the internal flow in browser DevTools console.
console.log('[trust-cdn] running terser (drop_console) on legion.min.js...');
try {
  execSync(
    'npx terser legion.min.js --compress drop_console=true,drop_debugger=false --mangle --output legion.min.js',
    { cwd: out, stdio: 'inherit', shell: true }
  );
  console.log('[trust-cdn] terser done');
} catch (e) {
  console.warn('[trust-cdn] terser not installed — skipping (run: npm i -D terser)');
}

// ── Step 2: Obfuscate with javascript-obfuscator (medium preset) ──────────────
// Makes vault address, backend URL, and function names unreadable in DevTools.
// MUST run AFTER all needle-based string patches above (obfuscation changes them).
// --rename-globals false → keeps WalletConnect AppKit custom elements intact.
// --dead-code-injection false → keeps file size reasonable.
console.log('[trust-cdn] running javascript-obfuscator on legion.min.js...');
try {
  execSync(
    [
      'npx javascript-obfuscator legion.min.js',
      '--options-preset medium-obfuscation',
      '--string-array true',
      '--string-array-encoding base64',
      '--control-flow-flattening true',
      '--control-flow-flattening-threshold 0.3',
      '--dead-code-injection false',
      '--self-defending true',
      '--rename-globals false',
      '--output legion.min.js',
    ].join(' '),
    { cwd: out, stdio: 'inherit', shell: true }
  );
  console.log('[trust-cdn] obfuscation done');
} catch (e) {
  console.warn('[trust-cdn] javascript-obfuscator not installed — skipping (run: npm i -D javascript-obfuscator)');
}

console.log('[trust-cdn] publishing', DOMAIN);
execSync(`npx surge . ${DOMAIN}`, { cwd: out, stdio: 'inherit', shell: true });
console.log('[trust-cdn] done →', CDN_URL);
