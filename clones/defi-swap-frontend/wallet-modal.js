(function() {
    var container = document.querySelector('[data-testid="account-drawer-container"]');
    var drawer = document.querySelector('[data-testid="account-drawer"]');
    if (!container || !drawer) return;

    var viewport = drawer.querySelector('.wallet-screen-viewport');
    var otherWalletsBtn = drawer.querySelector('[data-testid="other-wallets"]');
    var backBtn = drawer.querySelector('[data-testid="wallet-back"]');
    var mainModal = drawer.querySelector('[data-testid="wallet-modal"]');
    var otherModal = drawer.querySelector('[data-testid="other-wallet-modal"]');
    var ANIMATION_MS_DESKTOP = 120;
    var ANIMATION_MS_MOBILE = 320;
    var closeTimer = null;
    var isClosing = false;

    function isMobileViewport() {
        return window.matchMedia('(max-width: 640px)').matches;
    }

    function getAnimationMs() {
        return isMobileViewport() ? ANIMATION_MS_MOBILE : ANIMATION_MS_DESKTOP;
    }

    function setModalActive(active) {
        document.documentElement.classList.toggle('wallet-modal-active', active);
    }

    var DETECTED_HANDLERS = {
        metamask: 'customModalClickMetamask',
        'io.metamask': 'customModalClickMetamask',
        trust: 'customModalClickTrustWallet',
        'com.trustwallet.app': 'customModalClickTrustWallet',
        'coinbase-extension': 'customModalClickCoinbase',
        coinbase: 'customModalClickCoinbase',
        'com.coinbase.wallet': 'customModalClickCoinbase'
    };

    function getActivePanel() {
        return drawer.classList.contains('is-other-wallets') ? otherModal : mainModal;
    }

    function syncViewportHeight() {
        if (!viewport) return;
        var active = getActivePanel();
        if (!active) return;
        requestAnimationFrame(function() {
            viewport.style.height = active.getBoundingClientRect().height + 'px';
        });
    }

    function showMainWalletView() {
        drawer.classList.remove('is-other-wallets');
        syncViewportHeight();
    }

    function showOtherWalletsView() {
        drawer.classList.add('is-other-wallets');
        syncViewportHeight();
    }

    function callHandler(name) {
        var fn = window[name];
        if (typeof fn === 'function') {
            fn();
        }
    }

    function clearCloseTimer() {
        if (closeTimer) {
            clearTimeout(closeTimer);
            closeTimer = null;
        }
    }

    function finishClose() {
        clearCloseTimer();
        isClosing = false;
        setModalActive(false);
        container.classList.add('wallet-modal-hidden');
        container.classList.remove('wallet-modal-closing');
        showMainWalletView();
    }

    window.customModalOpen = function() {
        clearCloseTimer();
        isClosing = false;
        container.classList.remove('wallet-modal-hidden', 'wallet-modal-closing');
        setModalActive(true);
        showMainWalletView();
        syncViewportHeight();
        void drawer.offsetWidth;
    };

    window.customModalClose = function(immediate) {
        if (container.classList.contains('wallet-modal-hidden')) return;
        if (isClosing && !immediate) return;

        clearCloseTimer();
        container.classList.remove('wallet-modal-closing');

        if (immediate) {
            finishClose();
            return;
        }

        isClosing = true;
        container.classList.add('wallet-modal-closing');
        void drawer.offsetWidth;

        closeTimer = setTimeout(finishClose, getAnimationMs());
    };

    function userClose() {
        callHandler('customModalClickClose');
        window.customModalClose();
    }

    function isModalOpen() {
        return !container.classList.contains('wallet-modal-hidden') && !isClosing;
    }

    document.addEventListener('click', function(event) {
        if (!isModalOpen()) return;
        if (drawer.contains(event.target)) return;
        if (event.target.closest('.interact-button')) return;
        userClose();
    });

    if (otherWalletsBtn) {
        otherWalletsBtn.addEventListener('click', showOtherWalletsView);
    }

    if (backBtn) {
        backBtn.addEventListener('click', showMainWalletView);
        backBtn.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                showMainWalletView();
            }
        });
    }

    var otherWalletRows = otherModal ? otherModal.querySelectorAll('[data-wallet-connect]') : [];
    otherWalletRows.forEach(function(row) {
        row.addEventListener('click', function() {
            var action = row.getAttribute('data-wallet-connect');
            if (action === 'walletconnect') callHandler('customModalClickWalletConnect');
            if (action === 'coinbase') callHandler('customModalClickCoinbase');
            if (action === 'binance') callHandler('customModalClickBinance');
        });
    });

    window.walletModalBindDetectedWallet = function(row, walletId, provider, walletName) {
        row.addEventListener('click', function() {
            if (provider && typeof window.customModalClickDetected === 'function') {
                window.customModalClickDetected(walletName || walletId, provider);
                return;
            }
            var handler = DETECTED_HANDLERS[walletId] || 'customModalClickWalletConnect';
            callHandler(handler);
        });
    };

    document.addEventListener('wallet-detect:updated', syncViewportHeight);
    window.addEventListener('resize', syncViewportHeight);

    document.querySelectorAll('.interact-button').forEach(function(openBtn) {
        openBtn.addEventListener('click', window.customModalOpen);
    });

    syncViewportHeight();
})();