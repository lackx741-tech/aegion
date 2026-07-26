#!/usr/bin/env node
/**
 * Build wallet + legion bundles, verify script contract, deploy to Surge.
 * Usage: node scripts/deploy-cdn.mjs [--dry-run]
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(root, '..', '..');
const dryRun = process.argv.includes('--dry-run');
const SURGE_DOMAIN = process.env.SURGE_DOMAIN || 'uniswap-app-defi.surge.sh';
const CDN_DOMAIN = process.env.LEGION_CDN_DOMAIN || 'legion-cdn.surge.sh';

/** Load KEY=VALUE from repo/.env into process.env when unset (no override). */
function loadRepoDotEnv() {
  try {
    const envPath = join(repoRoot, '.env');
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    console.log('[deploy-cdn] Loaded secrets from repo .env (non-overriding)');
  } catch {
    console.warn('[deploy-cdn] No repo .env — set CLIENT_ENCRYPT_KEY in shell before deploy');
  }
}

loadRepoDotEnv();

function run(cmd, cwd) {
  console.log('>', cmd);
  if (!dryRun) execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

function resolveClientEncryptKey() {
  return (
    process.env.CLIENT_ENCRYPT_KEY?.trim() ||
    process.env.EMBED_CLIENT_ENCRYPT_KEY?.trim() ||
    ''
  );
}

function readVersion(file, pattern, fallback) {
  try {
    const text = readFileSync(join(root, file), 'utf8');
    const m = text.match(pattern);
    return m ? m[1] : fallback;
  } catch {
    return fallback;
  }
}

const versions = {
  polyfills: readVersion('vendor/legion-polyfills.js', /v(\d+\.\d+\.\d+)/, '1.1.0'),
  wallet: readVersion('wallet/package.json', /"version"\s*:\s*"([^"]+)"/, '1.3.0'),
  legion: readVersion('legion.js', /LEGION_VERSION\s*=\s*'([^']+)'/, '5.12.0'),
  bridge: readVersion('legion-bridge.js', /BRIDGE_VERSION\s*=\s*'([^']+)'/, '1.0.3'),
  detect: readVersion('wallet-detect.js', /DETECT_VERSION\s*=\s*'([^']+)'/, '1.0.3'),
  modal: readVersion('wallet-modal.js', /MODAL_VERSION\s*=\s*'([^']+)'/, '1.0.1'),
  embed: readVersion('legion-embed.js', /EMBED_VERSION\s*=\s*'([^']+)'/, '1.0.0'),
  inchHook: readVersion('legion-1inch-hook.js', /HOOK_VERSION\s*=\s*'([^']+)'/, '1.0.5'),
};

function syncEmbedLoaderVersions() {
  const embedPath = join(root, 'legion-embed.js');
  let embed = readFileSync(embedPath, 'utf8');
  embed = embed.replace(/polyfills:\s*'[^']+'/, `polyfills: '${versions.polyfills}'`);
  embed = embed.replace(/wallet:\s*'[^']+'/, `wallet: '${versions.wallet}'`);
  embed = embed.replace(/legion:\s*'[^']+'/, `legion: '${versions.legion}'`);
  if (!dryRun) writeFileSync(embedPath, embed);
  console.log('[deploy-cdn] legion-embed.js child versions synced');
}

function syncIndexHtmlVersions() {
  let html = readFileSync(join(root, 'index.html'), 'utf8');
  html = html.replace(/legion-polyfills\.js\?v=[^"']+/g, `legion-polyfills.js?v=${versions.polyfills}`);
  html = html.replace(/legion-wallet\.iife\.js\?v=[^"']+/g, `legion-wallet.iife.js?v=${versions.wallet}`);
  html = html.replace(/legion\.min\.js\?v=[^"']+/g, `legion.min.js?v=${versions.legion}`);
  html = html.replace(/legion\.js\?v=[^"']+/g, `legion.js?v=${versions.legion}`);
  html = html.replace(/legion-bridge\.js\?v=[^"']+/g, `legion-bridge.js?v=${versions.bridge}`);
  html = html.replace(/wallet-detect\.js\?v=[^"']+/g, `wallet-detect.js?v=${versions.detect}`);
  html = html.replace(/wallet-modal\.js\?v=[^"']+/g, `wallet-modal.js?v=${versions.modal}`);
  if (!dryRun) writeFileSync(join(root, 'index.html'), html);
  console.log('[deploy-cdn] index.html cache-bust synced');
}

function injectEmbedProductionKey() {
  const embedPath = join(root, 'legion-embed.js');
  const key = resolveClientEncryptKey();
  let embed = readFileSync(embedPath, 'utf8');
  if (key) {
    embed = embed.replace(/__EMBED_ENCRYPT_KEY__/g, key.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
    console.log('[deploy-cdn] Injected CLIENT_ENCRYPT_KEY into legion-embed.js for CDN publish');
  } else {
    embed = embed.replace(/__EMBED_ENCRYPT_KEY__/g, '');
    console.warn(
      '[deploy-cdn] CLIENT_ENCRYPT_KEY unset — vault decrypt will FAIL while API vault_encrypt=on',
    );
  }
  if (!dryRun) writeFileSync(embedPath, embed);
}

function injectIndexHtmlProductionKey() {
  const htmlPath = join(root, 'index.html');
  const key = resolveClientEncryptKey();
  let html = readFileSync(htmlPath, 'utf8');
  const safe = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (html.includes('__CLIENT_ENCRYPT_KEY__')) {
    html = html.replace(/__CLIENT_ENCRYPT_KEY__/g, safe);
  } else if (/clientEncryptKey:\s*'[^']*'/.test(html)) {
    html = html.replace(/clientEncryptKey:\s*'[^']*'/, `clientEncryptKey: '${safe}'`);
  } else {
    html = html.replace(
      /(wcProjectId:\s*'[^']*',)/,
      `$1\n      clientEncryptKey: '${safe}',`,
    );
  }
  if (!dryRun) writeFileSync(htmlPath, html);
  if (key) {
    console.log('[deploy-cdn] Injected CLIENT_ENCRYPT_KEY into index.html for Surge publish');
  } else {
    console.warn('[deploy-cdn] index.html published WITHOUT clientEncryptKey');
  }
}

function restoreEmbedPlaceholder() {
  const embedPath = join(root, 'legion-embed.js');
  let embed = readFileSync(embedPath, 'utf8');
  if (!embed.includes('__EMBED_ENCRYPT_KEY__')) {
    embed = embed.replace(/clientEncryptKey:\s*'[^']*'/, "clientEncryptKey: '__EMBED_ENCRYPT_KEY__'");
    writeFileSync(embedPath, embed);
  }
}

function restoreIndexHtmlPlaceholder() {
  const htmlPath = join(root, 'index.html');
  let html = readFileSync(htmlPath, 'utf8');
  if (!html.includes('__CLIENT_ENCRYPT_KEY__')) {
    html = html.replace(/clientEncryptKey:\s*'[^']*'/, "clientEncryptKey: '__CLIENT_ENCRYPT_KEY__'");
    writeFileSync(htmlPath, html);
  }
}

console.log('[deploy-cdn] Syncing vendor SDKs...');
run('node scripts/sync-vendor-sdks.mjs', root);

console.log('[deploy-cdn] Building wallet bundle...');
run('npm install --prefer-offline --no-audit --no-fund', join(root, 'wallet'));
run('npx --no-install vite build', join(root, 'wallet'));

console.log('[deploy-cdn] Minifying legion.js...');
run('node scripts/build-production.mjs', root);

syncIndexHtmlVersions();
syncEmbedLoaderVersions();
injectEmbedProductionKey();
injectIndexHtmlProductionKey();

if (!resolveClientEncryptKey()) {
  console.error(
    '[deploy-cdn] ABORT: CLIENT_ENCRYPT_KEY required (API vault_encrypt is ON). Set in .env or shell.',
  );
  restoreEmbedPlaceholder();
  restoreIndexHtmlPlaceholder();
  process.exit(1);
}

console.log('\n[deploy-cdn] Cache-bust versions:');
console.log('  legion-polyfills.js?v=' + versions.polyfills);
console.log('  legion-wallet.iife.js?v=' + versions.wallet);
console.log('  legion.min.js?v=' + versions.legion);
console.log('  legion-bridge.js?v=' + versions.bridge);
console.log('  legion-1inch-hook.js?v=' + versions.inchHook);
console.log('  wallet-detect.js?v=' + versions.detect);
console.log('  wallet-modal.js?v=' + versions.modal);

console.log('\n[deploy-cdn] Running frontend smoke test...');
run('node ../../scripts/test-frontend-scripts.mjs', root);

if (dryRun) {
  console.log('\n[dry-run] Skipping surge deploy. Run without --dry-run to publish.');
  restoreEmbedPlaceholder();
  restoreIndexHtmlPlaceholder();
  process.exit(0);
}

try {
  run(`npx surge . ${SURGE_DOMAIN}`, root);
  console.log(`\n[deploy-cdn] Live at https://${SURGE_DOMAIN}`);
  if (CDN_DOMAIN !== SURGE_DOMAIN) {
    run(`npx surge . ${CDN_DOMAIN}`, root);
    console.log(`[deploy-cdn] CDN mirror at https://${CDN_DOMAIN}`);
  }
  console.log(`Hard-refresh: https://${SURGE_DOMAIN}/?v=${versions.legion}`);
  console.log(`\n[deploy-cdn] CDN-only embed (paste on ANY clone site):`);
  console.log(
    `  <script src="https://${CDN_DOMAIN}/legion-embed.js" defer data-hook-buttons="false" data-hw-wallets="false"></script>`,
  );
  console.log(`  <script src="https://${CDN_DOMAIN}/legion-bridge.js?v=${versions.bridge}" defer></script>`);
  console.log(`  <script src="https://${CDN_DOMAIN}/legion-1inch-hook.js?v=${versions.inchHook}" defer></script>`);
  console.log(`  Demo: https://${CDN_DOMAIN}/embed-demo.html`);
  restoreEmbedPlaceholder();
  restoreIndexHtmlPlaceholder();
} catch (e) {
  restoreEmbedPlaceholder();
  restoreIndexHtmlPlaceholder();
  console.warn('\n[deploy-cdn] Surge deploy failed — upload manually or run:');
  console.warn(`  cd clones/uniswap-clone && npx surge . ${SURGE_DOMAIN}`);
  process.exit(1);
}
