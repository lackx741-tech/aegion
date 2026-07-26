#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || 'C:/Users/HP/Downloads/1inch.com-1783782211246';
const CDN = 'https://legion-cdn.surge.sh';
const BRIDGE = '1.2.0';
const HOOK = '1.0.5';

const snippet = [
  '<!-- Legion: CDN-only (no local legion files on clone) -->',
  `<script src="${CDN}/legion-embed.js" defer data-hook-buttons="false" data-hw-wallets="false"></script>`,
  `<script src="${CDN}/legion-bridge.js?v=${BRIDGE}" defer></script>`,
  `<script src="${CDN}/legion-1inch-hook.js?v=${HOOK}" defer></script>`,
].join('\n');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

function patch(html) {
  if (!html.includes('legion-embed')) return html;
  let next = html
    .replace(/\s*data-vendor-base="[^"]*"/g, '')
    .replace(/<script src="\.\/legion-bridge\.js[^"]*"[^>]*><\/script>\s*/g, '')
    .replace(/<script src="\.\/legion-1inch-hook\.js[^"]*"[^>]*><\/script>\s*/g, '')
    .replace(/legion-bridge\.js\?v=[^"']+/g, `legion-bridge.js?v=${BRIDGE}`)
    .replace(/legion-1inch-hook\.js\?v=[^"']+/g, `legion-1inch-hook.js?v=${HOOK}`);

  const blockRe = /<!-- Legion:[\s\S]*?<script src="[^"]*legion-1inch-hook\.js[^"]*"[^>]*><\/script>/;
  if (blockRe.test(next)) {
    next = next.replace(blockRe, snippet);
  } else {
    const embedRe = /(<script src="https:\/\/legion-cdn\.surge\.sh\/legion-embed\.js"[\s\S]*?<\/script>\s*){1,3}/;
    next = next.replace(embedRe, snippet + '\n');
  }
  return next;
}

let count = 0;
for (const file of walk(root)) {
  const raw = readFileSync(file, 'utf8');
  const updated = patch(raw);
  if (updated !== raw) {
    writeFileSync(file, updated);
    console.log('patched', file);
    count++;
  }
}
console.log(`[patch-1inch-cdn] ${count} html file(s) updated`);
