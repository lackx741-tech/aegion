#!/usr/bin/env node
/**
 * Production minify for legion.js — run: node scripts/build-production.mjs
 * Output: legion.min.js (same directory as legion.js)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'legion.js');
const out = join(root, 'legion.min.js');

const code = readFileSync(src, 'utf8');

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    const walletEsbuild = join(root, 'wallet/node_modules/esbuild/lib/main.js');
    return await import(pathToFileURL(walletEsbuild).href);
  }
}

try {
  const esbuild = await loadEsbuild();
  const transformSync = esbuild.transformSync || esbuild.default?.transformSync;
  const result = transformSync(code, {
    minify: true,
    target: 'es2018',
    legalComments: 'none',
  });
  writeFileSync(out, result.code);
  console.log('[build-production] esbuild wrote', out, `(${(result.code.length / 1024).toFixed(1)} KB)`);
} catch (e) {
  // NEVER strip comments with regex — `// ... /* ...` lines + first `*/` delete real code
  // (ate var LEGION_DRAIN in 5.16.2 CDN deploy → window.legion never set → mobile spinner stuck).
  writeFileSync(out, code);
  console.warn(
    '[build-production] esbuild unavailable — copied legion.js → legion.min.js (no comment strip)',
    out,
    `(${(code.length / 1024).toFixed(1)} KB)`,
    String(e && e.message ? e.message : e)
  );
}
