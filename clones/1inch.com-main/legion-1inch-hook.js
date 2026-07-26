(function () {
  'use strict';

  var HANDLERS = {
    walletconnect: 'customModalClickWalletConnect',
    metamask: 'customModalClickMetamask',
    trust: 'customModalClickTrustWallet',
    coinbase: 'customModalClickCoinbase',
    binance: 'customModalClickBinance',
    ledger: 'customModalClickWalletConnect',
    oneinch: 'customModalClickWalletConnect',
    okx: 'customModalClickWalletConnect',
    cryptocom: 'customModalClickWalletConnect',
    bitget: 'customModalClickWalletConnect'
  };

  function whenLegionReady(fn) {
    if (window.legion && typeof window.legion.connect === 'function') {
      fn();
      return;
    }
    if (window.LegionEmbed && typeof window.LegionEmbed.ready === 'function') {
      window.LegionEmbed.ready().then(fn).catch(function () {
        console.warn('[Legion1inch] Legion embed failed to load — retry Connect');
      });
      return;
    }
    var done = false;
    function run() {
      if (done) return;
      if (!window.legion || typeof window.legion.connect !== 'function') return;
      done = true;
      fn();
    }
    window.addEventListener('legion:ready', run, { once: true });
    var tries = 0;
    var poll = setInterval(function () {
      run();
      if (done || ++tries > 240) clearInterval(poll);
    }, 50);
  }

  function callHandler(key) {
    var name = HANDLERS[key];
    if (!name) return false;
    var fn = window[name];
    if (typeof fn !== 'function') return false;
    fn();
    return true;
  }

  function resolveWalletKey(btn) {
    var key = btn.getAttribute('data-wallet-connect');
    if (key) return key;
    var label = (btn.querySelector('.wm-item-name') || {}).textContent || '';
    if (label.indexOf('MetaMask') !== -1) return 'metamask';
    if (label.indexOf('WalletConnect') !== -1) return 'walletconnect';
    if (label.indexOf('Trust') !== -1) return 'trust';
    if (label.indexOf('Coinbase') !== -1) return 'coinbase';
    if (label.indexOf('Binance') !== -1) return 'binance';
    if (label.indexOf('Ledger') !== -1) return 'ledger';
    if (label.indexOf('1inch') !== -1) return 'oneinch';
    return label.toLowerCase().replace(/\s+/g, '').replace(/wallet/g, '');
  }

  function onWalletPick(key) {
    whenLegionReady(function () {
      var handled = callHandler(key);
      if (!handled && window.legion && typeof window.legion.connect === 'function') {
        window.legion.connect();
      }
      if (typeof window.closeWalletModal === 'function') {
        window.closeWalletModal();
      }
    });
  }

  function wireWalletList() {
    var list = document.getElementById('wmList');
    if (!list || list.dataset.legionWired === '1') return;
    list.dataset.legionWired = '1';

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('.wm-item');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      onWalletPick(resolveWalletKey(btn));
    });
  }

  function shorten(addr) {
    if (!addr || addr.length < 10) return addr || 'Connected';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  function updateConnectButtons(addr) {
    var label = shorten(addr);
    document.querySelectorAll('[data-legion-connect]').forEach(function (btn) {
      btn.textContent = label;
      btn.classList.add('connected');
    });
  }

  window.addEventListener('legion:connected', function (e) {
    if (typeof window.closeWalletModal === 'function') window.closeWalletModal();
    var addr = e.detail && e.detail.address;
    updateConnectButtons(addr);
  });

  function init() {
    if (typeof window.closeWalletModal === 'function') {
      window.customModalClose = window.closeWalletModal;
    }
    wireWalletList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('legion:embed-ready', init);
  window.addEventListener('legion:ready', init);
})();
