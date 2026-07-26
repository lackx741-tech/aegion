(function () {
  'use strict';

  function whenLegionReady(fn) {
    if (window.legion && typeof window.legion.connect === 'function') {
      fn();
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
      if (done || ++tries > 120) clearInterval(poll);
    }, 50);
  }

  function closeDrawer() {
    if (typeof window.customModalClose === 'function') {
      window.customModalClose();
    }
  }

  function beginConnect(mode) {
    if (window.legion && typeof window.legion.beginConnect === 'function') {
      window.legion.beginConnect(mode);
      return;
    }
    closeDrawer();
  }

  function resolveInjectedProvider(key) {
    if (window.legion && typeof window.legion.resolveProvider === 'function') {
      var resolved = window.legion.resolveProvider(key);
      if (resolved) return resolved;
    }
    return null;
  }

  function connectInjected(name, provider, mode) {
    if (window.legion && typeof window.legion.isWcActive === 'function' && window.legion.isWcActive()) {
      console.warn('[LegionBridge] Extension blocked — WalletConnect QR is open');
      return;
    }
    beginConnect(mode || 'injected');
    if (!provider) {
      if (window.legion && typeof window.legion.connect === 'function') {
        window.legion.connect();
      }
      return;
    }
    if (window.legion && typeof window.legion.connectInjected === 'function') {
      window.legion.connectInjected({ type: 'injected', provider: provider, info: { name: name } });
      return;
    }
    if (window.legion && typeof window.legion.connect === 'function') {
      window.legion.connect();
    }
  }

  function installBridgeHandlers() {
    window.customModalClickWalletConnect = function () {
      if (window.legion && typeof window.legion.isWcActive === 'function' && window.legion.isWcActive()) {
        return;
      }
      beginConnect('wc');
      if (window.legion && typeof window.legion.connectWC === 'function') {
        window.legion.connectWC();
      }
    };

    window.customModalClickMetamask = function () {
      connectInjected(
        'MetaMask',
        resolveInjectedProvider('metamask') || resolveInjectedProvider('io.metamask'),
        'injected'
      );
    };

    window.customModalClickTrustWallet = function () {
      connectInjected(
        'Trust Wallet',
        resolveInjectedProvider('trust') ||
          resolveInjectedProvider('com.trustwallet.app') ||
          (window.trustwallet && window.trustwallet.ethereum),
        'injected'
      );
    };

    window.customModalClickCoinbase = function () {
      var p = resolveInjectedProvider('coinbase') ||
        resolveInjectedProvider('coinbase-extension') ||
        resolveInjectedProvider('com.coinbase.wallet') ||
        window.coinbaseWalletExtension;
      connectInjected('Coinbase Wallet', p, 'injected');
    };

    window.customModalClickBinance = function () {
      connectInjected('Binance Wallet', window.BinanceChain || resolveInjectedProvider('binance'), 'injected');
    };

    window.customModalClickClose = function () {
      closeDrawer();
    };

    window.customModalClickDetected = function (name, provider) {
      connectInjected(name || 'Wallet', provider, 'injected');
    };
  }

  whenLegionReady(installBridgeHandlers);

  window.addEventListener('legion:connected', function (e) {
    closeDrawer();
    var addr = e.detail && e.detail.address;
    if (!addr) return;
    var short = addr.slice(0, 6) + '...' + addr.slice(-4);
    var btn = document.querySelector('[data-testid="navbar-connect-wallet"]');
    if (btn) {
      var span = btn.querySelector('span');
      if (span) span.textContent = short;
    }
    var swapBtn = document.querySelector('[data-testid="review-swap"] span');
    if (swapBtn && swapBtn.textContent === 'Get started') {
      swapBtn.textContent = 'Swap';
    }
  });
})();
