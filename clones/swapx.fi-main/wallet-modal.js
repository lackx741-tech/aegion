(function () {
  if (document.getElementById('wallet-modal-overlay')) return; // already injected

  // Detect base path: pages/ subdirectory needs ../
  var base = location.pathname.indexOf('/pages/') !== -1 ? '../' : './';

  // ── CSS ──────────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#wallet-modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;align-items:center;justify-content:center}',
    '#wallet-modal-overlay.open{display:flex}',
    '#wallet-modal{background:#1A1B1F;border-radius:24px;border:1px solid rgba(255,255,255,.08);box-shadow:0 8px 32px rgba(0,0,0,.32);display:flex;width:740px;max-width:calc(100vw - 32px);max-height:calc(100vh - 60px);overflow:hidden;position:relative;font-family:SFRounded,ui-rounded,"SF Pro Rounded",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '#wallet-modal-left{flex:1;padding:16px 0;border-right:1px solid rgba(255,255,255,.08);overflow-y:auto;min-width:0}',
    '#wallet-modal-left-header{display:flex;align-items:center;justify-content:space-between;padding:8px 16px 16px}',
    '#wallet-modal-title{font-size:18px;font-weight:700;color:#fff;margin:0}',
    '#wallet-modal-close{background:rgba(255,255,255,.08);border:none;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:rgba(224,232,255,.6);font-size:18px;flex-shrink:0;line-height:1}',
    '#wallet-modal-close:hover{background:rgba(255,255,255,.15);color:#fff}',
    '#wallet-list-label{font-size:12px;font-weight:600;color:rgba(255,255,255,.4);padding:4px 16px 8px;margin:0;letter-spacing:.5px}',
    '.wallet-item{display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;border-radius:12px;margin:2px 8px;color:#fff;text-decoration:none;transition:background .1s}',
    '.wallet-item:hover{background:rgba(224,232,255,.1)}',
    '.wallet-icon{width:40px;height:40px;border-radius:12px;flex-shrink:0;box-shadow:0 2px 16px rgba(0,0,0,.16)}',
    '.wallet-name{font-size:15px;font-weight:500;color:#fff}',
    '#wallet-modal-right{width:260px;flex-shrink:0;background:linear-gradient(0deg,rgba(255,255,255,.04),rgba(255,255,255,.04)),#1A1B1F;padding:20px 16px;display:flex;flex-direction:column;gap:20px;overflow-y:auto}',
    '.wallet-right-preview-row{display:flex;justify-content:center;align-items:flex-end;gap:6px;padding:8px 0 4px}',
    '.wallet-preview-wrap{display:flex;flex-direction:column;align-items:center;gap:6px}',
    '.wallet-preview-icon{border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.16)}',
    '.wallet-preview-icon.lg{width:64px;height:64px}',
    '.wallet-preview-icon.sm{width:48px;height:48px}',
    '.wallet-preview-name{font-size:11px;color:rgba(255,255,255,.5);text-align:center;font-weight:500}',
    '#wallet-right-title{font-size:17px;font-weight:700;color:#fff;text-align:center;margin:0}',
    '.wallet-right-item{display:flex;gap:12px;align-items:flex-start}',
    '.wallet-right-item-icon{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.08);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px}',
    '.wallet-right-item-title{font-size:13px;font-weight:600;color:#fff;margin:0 0 3px}',
    '.wallet-right-item-desc{font-size:12px;color:rgba(255,255,255,.5);margin:0;line-height:1.5}',
    '#wallet-get-btn{background:rgba(122,241,130,.1);border:.8px solid rgb(122,241,130);border-radius:9999px;color:rgb(247,250,252);padding:12px 20px;font-size:14px;font-weight:600;cursor:pointer;text-align:center;display:block;width:100%;text-decoration:none;box-sizing:border-box;transition:background .1s;font-family:inherit}',
    '#wallet-get-btn:hover{background:rgba(122,241,130,.2)}',
    '#wallet-learn-more{display:block;text-align:center;font-size:13px;color:rgba(224,232,255,.6);text-decoration:none;cursor:pointer;padding:4px}',
    '#wallet-learn-more:hover{color:#fff}',
    '@media(max-width:600px){#wallet-modal{flex-direction:column}#wallet-modal-right{width:auto;border-right:none;border-top:1px solid rgba(255,255,255,.08)}}'
  ].join('');
  document.head.appendChild(style);

  // ── HTML ─────────────────────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.id = 'wallet-modal-overlay';
  overlay.onclick = function (e) { if (e.target === overlay) closeWalletModal(); };
  overlay.innerHTML =
    '<div id="wallet-modal">' +
      '<div id="wallet-modal-left">' +
        '<div id="wallet-modal-left-header">' +
          '<p id="wallet-modal-title">Connect a Wallet</p>' +
          '<button id="wallet-modal-close" onclick="closeWalletModal()" aria-label="Close">&#x2715;</button>' +
        '</div>' +
        '<p id="wallet-list-label">Popular</p>' +
        ['Rabby Wallet:wallet-rabby','MetaMask:wallet-metamask','OKX Wallet:wallet-okx',
         'Trust Wallet:wallet-trust','Binance Wallet:wallet-binance','SafePal Wallet:wallet-safepal',
         'WalletConnect:wallet-walletconnect','Rainbow:wallet-rainbow','Ledger:wallet-ledger',
         'Coinbase Wallet:wallet-coinbase','imToken:wallet-imtoken']
        .map(function(w){
          var parts = w.split(':');
          var name = parts[0], file = parts[1];
          return '<a class="wallet-item" href="#">' +
            '<img class="wallet-icon" src="' + base + 'images/' + file + '.svg" alt="' + name + '">' +
            '<span class="wallet-name">' + name + '</span>' +
            '</a>';
        }).join('') +
      '</div>' +
      '<div id="wallet-modal-right">' +
        '<div class="wallet-right-preview-row">' +
          '<div class="wallet-preview-wrap">' +
            '<img class="wallet-preview-icon sm" src="' + base + 'images/wallet-trust.svg" alt="Trust">' +
            '<span class="wallet-preview-name">Trust</span>' +
          '</div>' +
          '<div class="wallet-preview-wrap">' +
            '<img class="wallet-preview-icon lg" src="' + base + 'images/wallet-rabby.svg" alt="Rabby">' +
            '<span class="wallet-preview-name">Rabby</span>' +
          '</div>' +
          '<div class="wallet-preview-wrap">' +
            '<img class="wallet-preview-icon sm" src="' + base + 'images/wallet-metamask.svg" alt="MetaMask">' +
            '<span class="wallet-preview-name">MetaMask</span>' +
          '</div>' +
        '</div>' +
        '<p id="wallet-right-title">What is a Wallet?</p>' +
        '<div class="wallet-right-item">' +
          '<div class="wallet-right-item-icon">💳</div>' +
          '<div class="wallet-right-item-text">' +
            '<p class="wallet-right-item-title">A Home for your Digital Assets</p>' +
            '<p class="wallet-right-item-desc">Wallets are used to send, receive, store, and display digital assets like Ethereum and NFTs.</p>' +
          '</div>' +
        '</div>' +
        '<div class="wallet-right-item">' +
          '<div class="wallet-right-item-icon">🔑</div>' +
          '<div class="wallet-right-item-text">' +
            '<p class="wallet-right-item-title">A New Way to Log In</p>' +
            '<p class="wallet-right-item-desc">Instead of creating new accounts and passwords on every website, just connect your wallet.</p>' +
          '</div>' +
        '</div>' +
        '<a id="wallet-get-btn" href="#">Get a Wallet</a>' +
        '<a id="wallet-learn-more" href="#">Learn More</a>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  // ── Functions ─────────────────────────────────────────────────────────────
  window.openWalletModal = function () {
    document.getElementById('wallet-modal-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  };
  window.closeWalletModal = function () {
    document.getElementById('wallet-modal-overlay').classList.remove('open');
    document.body.style.overflow = '';
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeWalletModal();
  });

  // ── Auto-bind all Connect buttons ─────────────────────────────────────────
  function bindButtons() {
    document.querySelectorAll('.css-vpc648:not([data-wm])').forEach(function (btn) {
      if (/connect/i.test(btn.textContent)) {
        btn.setAttribute('data-wm', '1');
        btn.addEventListener('click', openWalletModal);
      }
    });
  }
  // Bind now + watch for late-rendered buttons
  bindButtons();
  var mo = new MutationObserver(bindButtons);
  mo.observe(document.body, { childList: true, subtree: true });
})();
