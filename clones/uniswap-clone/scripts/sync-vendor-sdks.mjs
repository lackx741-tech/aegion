#!/usr/bin/env node
/**
 * Sync optional vendor SDKs to vendor/ for universal CDN (any clone site).
 * Reown AppKit (legion-wallet.iife.js) covers 300+ WC wallets — this adds lazy-load fallbacks.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const walletDir = join(root, 'wallet');
const hwStaging = join(root, '.vendor-staging');

const REMOTE = [
  {
    file: 'solana-web3.iife.min.js',
    urls: [
      'https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js',
    ],
  },
  {
    file: 'tonconnect-sdk.min.js',
    urls: [
      'https://unpkg.com/@tonconnect/sdk@3.0.5/dist/tonconnect-sdk.min.js',
      'https://cdn.jsdelivr.net/npm/@tonconnect/sdk@3.0.5/dist/tonconnect-sdk.min.js',
    ],
  },
  {
    file: 'trezor-connect-web.min.js',
    urls: [],
  },
  {
    file: 'tronweb.iife.js',
    urls: [
      'https://unpkg.com/tronweb@5.3.2/dist/TronWeb.js',
    ],
  },
  {
    file: 'qrcode.min.js',
    urls: [
      'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js',
    ],
  },
];

async function fetchFirst(urls, dest) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(dest, buf);
      console.log('[sync-vendor] OK', dest.replace(root, '.'), `(${(buf.length / 1024).toFixed(1)} KB)`);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    const p = join(walletDir, 'node_modules/esbuild/lib/main.js');
    return import(pathToFileURL(p).href);
  }
}

function installHwPackages() {
  mkdirSync(hwStaging, { recursive: true });
  writeFileSync(
    join(hwStaging, 'package.json'),
    JSON.stringify({ name: 'legion-vendor-staging', private: true, type: 'module' }, null, 2),
  );
  execSync(
    'npm install --ignore-scripts --no-save @ledgerhq/hw-transport-webusb@6.35.0 @ledgerhq/hw-app-eth@7.8.8 @ledgerhq/devices@8.16.0 @trezor/connect-web@9.7.3',
    { cwd: hwStaging, stdio: 'inherit', shell: true },
  );
}

function hwNodePath(...parts) {
  return join(hwStaging, 'node_modules', ...parts);
}

function copyTrezorFromNodeModules() {
  return loadEsbuild().then((esbuild) => {
    const buildSync = esbuild.buildSync || esbuild.default?.buildSync;
    if (!buildSync) throw new Error('esbuild unavailable');
    buildSync({
      entryPoints: [hwNodePath('@trezor/connect-web/lib/index.js')],
      bundle: true,
      format: 'iife',
      globalName: 'TrezorConnect',
      outfile: join(vendor, 'trezor-connect-web.min.js'),
      platform: 'browser',
      target: 'es2020',
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const kb = readFileSync(join(vendor, 'trezor-connect-web.min.js')).length / 1024;
    console.log('[sync-vendor] OK trezor-connect-web.min.js', `(${kb.toFixed(1)} KB, bundled)`);
  });
}

function bundleLedgerUmd() {
  installHwPackages();
  return copyTrezorFromNodeModules().then(() => loadEsbuild()).then((esbuild) => {
    const buildSync = esbuild.buildSync || esbuild.default?.buildSync;
    if (!buildSync) throw new Error('esbuild unavailable');
    buildSync({
      entryPoints: [hwNodePath('@ledgerhq/hw-transport-webusb/lib-es/TransportWebUSB.js')],
      bundle: true,
      format: 'iife',
      globalName: 'LedgerTransportWebUSB',
      outfile: join(vendor, 'ledger-transport-webusb.umd.js'),
      platform: 'browser',
      target: 'es2020',
      minify: true,
    });
    buildSync({
      entryPoints: [hwNodePath('@ledgerhq/hw-app-eth/lib-es/Eth.js')],
      bundle: true,
      format: 'iife',
      globalName: 'LedgerEth',
      outfile: join(vendor, 'ledger-app-eth.umd.js'),
      platform: 'browser',
      target: 'es2020',
      minify: true,
    });
    console.log('[sync-vendor] OK ledger-transport-webusb.umd.js + ledger-app-eth.umd.js');
  });
}

async function main() {
  mkdirSync(vendor, { recursive: true });

  for (const item of REMOTE) {
    const dest = join(vendor, item.file);
    if (!item.urls || !item.urls.length) continue;
    try {
      await fetchFirst(item.urls, dest);
    } catch (e) {
      if (existsSync(dest)) {
        console.warn('[sync-vendor] keep existing', item.file, '—', e.message);
      } else {
        console.warn('[sync-vendor] MISSING', item.file, '—', e.message);
      }
    }
  }

  const caipSrc = join(walletDir, 'src/caip-registry.js');
  if (existsSync(caipSrc)) {
    copyFileSync(caipSrc, join(vendor, 'legion-caip-registry.js'));
    console.log('[sync-vendor] OK vendor/legion-caip-registry.js');
  }

  try {
    await bundleLedgerUmd();
  } catch (e) {
    console.warn('[sync-vendor] HW wallet UMD skipped:', e.message);
  }

  const manifest = {
    updated: new Date().toISOString(),
    note: 'Universal CDN vendor — Reown AppKit in legion-wallet.iife.js covers 300+ WC wallets',
    files: REMOTE.map((r) => r.file).concat([
      'legion-polyfills.js',
      'legion-wallet.iife.js',
      'legion-caip-registry.js',
      'ledger-transport-webusb.umd.js',
      'ledger-app-eth.umd.js',
      'wc-ethereum-provider.umd.js',
      'wc-universal-provider.umd.js',
    ]),
  };
  writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('[sync-vendor] manifest.json written');
}

main().catch((e) => {
  console.error('[sync-vendor] fatal:', e.message);
  process.exit(1);
});
