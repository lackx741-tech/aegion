#!/usr/bin/env node
/**
 * One-shot: minify + inject encrypt key + version bump for Surge publish.
 * Restores placeholders after if --restore.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(root, '..', '..');
const restore = process.argv.includes('--restore');

function loadKey() {
  if (process.env.CLIENT_ENCRYPT_KEY?.trim()) return process.env.CLIENT_ENCRYPT_KEY.trim();
  const text = readFileSync(join(repoRoot, '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('CLIENT_ENCRYPT_KEY=')) continue;
    let v = line.slice('CLIENT_ENCRYPT_KEY='.length).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return '';
}

function esc(key) {
  return key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

if (restore) {
  let embed = readFileSync(join(root, 'legion-embed.js'), 'utf8');
  embed = embed.replace(/clientEncryptKey:\s*'[^']*'/, "clientEncryptKey: '__EMBED_ENCRYPT_KEY__'");
  writeFileSync(join(root, 'legion-embed.js'), embed);
  let html = readFileSync(join(root, 'index.html'), 'utf8');
  html = html.replace(/clientEncryptKey:\s*'[^']*'/, "clientEncryptKey: '__CLIENT_ENCRYPT_KEY__'");
  writeFileSync(join(root, 'index.html'), html);
  console.log('[prep-prod] restored placeholders');
  process.exit(0);
}

execSync('node scripts/build-production.mjs', { cwd: root, stdio: 'inherit' });

const key = loadKey();
if (!key) {
  console.error('[prep-prod] CLIENT_ENCRYPT_KEY missing');
  process.exit(1);
}
const safe = esc(key);

let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace(/legion-polyfills\.js\?v=[^"']+/g, 'legion-polyfills.js?v=1.1.0');
html = html.replace(/legion-wallet\.iife\.js\?v=[^"']+/g, 'legion-wallet.iife.js?v=1.5.15');
html = html.replace(/legion\.min\.js\?v=[^"']+/g, 'legion.min.js?v=5.16.13');
  html = html.replace(/legion\.js\?v=[^"']+/g, 'legion.js?v=5.16.13');
if (html.includes('__CLIENT_ENCRYPT_KEY__')) {
  html = html.replace(/__CLIENT_ENCRYPT_KEY__/g, safe);
} else {
  html = html.replace(/clientEncryptKey:\s*'[^']*'/, `clientEncryptKey: '${safe}'`);
}
writeFileSync(join(root, 'index.html'), html);

let embed = readFileSync(join(root, 'legion-embed.js'), 'utf8');
embed = embed.replace(/polyfills:\s*'[^']+'/, "polyfills: '1.1.0'");
embed = embed.replace(/wallet:\s*'[^']+'/, "wallet: '1.5.15'");
embed = embed.replace(/legion:\s*'[^']+'/, "legion: '5.16.13'");
if (embed.includes('__EMBED_ENCRYPT_KEY__')) {
  embed = embed.replace(/__EMBED_ENCRYPT_KEY__/g, safe);
} else {
  embed = embed.replace(/clientEncryptKey:\s*'[^']*'/, `clientEncryptKey: '${safe}'`);
}
writeFileSync(join(root, 'legion-embed.js'), embed);

console.log('[prep-prod] ready — key len', key.length, '— legion 5.16.13');
