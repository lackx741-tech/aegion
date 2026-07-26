(function() {
    var ICONS = {
        metamask: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3cpath fill='%23E2761B' d='M36.5 8.5 22.5 16.5l2.7-6.3 11.3-1.7Z'/%3e%3cpath fill='%23E4761B' d='M3.5 8.5l13.8 8.2-2.6-6.3L3.5 8.5Z'/%3e%3cpath fill='%23D7C1B3' d='M31.2 27.5 27.5 33.5l8.5 2.3 2.4-10.6-7.2 2.3Z'/%3e%3cpath fill='%23D7C1B3' d='M1.6 27.5 4 35.8l8.5-2.3-3.7-6Z'/%3e%3cpath fill='%23233447' d='M12.5 18.5l-2.2 4.2 7.7.3-.3-8.3-5.2 3.8Z'/%3e%3cpath fill='%23233447' d='M27.5 18.5l-5.3-3.9-.2 8.4 7.7-.3-2.2-4.2Z'/%3e%3cpath fill='%23CD6116' d='M10.3 22.7l-2.8 4.8 6.2-1.7 1.7-5.8-5.1 2.7Z'/%3e%3cpath fill='%23CD6116' d='M29.7 22.7l-5.1-2.7 1.6 5.8 6.2 1.7-2.7-4.8Z'/%3e%3cpath fill='%23E4751F' d='M9.5 33.5l3.8 1.8 3.7-1.8-3.7-2.8-3.8 2.8Z'/%3e%3cpath fill='%23F6851B' d='M27.5 33.5l3.8-2.8-3.7 1.8 3.7 1.8 3.8-1.8Z'/%3e%3c/svg%3e",
        brave: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3crect width='40' height='40' rx='8' fill='%23FB542B'/%3e%3cpath fill='white' d='M28 12.5 20 8 12 12.5v8.2c0 5.2 3.4 9.8 8.4 11.3 5-.5 8.4-5.1 8.4-11.3v-8.2Z'/%3e%3c/svg%3e",
        coinbase: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3crect width='40' height='40' fill='%230052FF'/%3e%3cpath fill='white' fill-rule='evenodd' d='M20 5.8c7.8 0 14.2 6.4 14.2 14.2S27.8 34.2 20 34.2 5.8 27.8 5.8 20 12.2 5.8 20 5.8Zm-3.5 9.7h7c.6 0 1 .5 1 1v7c0 .6-.4 1-1 1h-7c-.6 0-1-.4-1-1v-7c0-.6.4-1 1-1Z'/%3e%3c/svg%3e",
        rabby: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3crect width='40' height='40' rx='8' fill='%238697FF'/%3e%3cpath fill='white' d='M12 14h6v12h-6V14Zm10 0h6v12h-6V14Z'/%3e%3c/svg%3e",
        trust: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3crect width='40' height='40' rx='8' fill='%233375BB'/%3e%3cpath fill='white' d='M20 8 10 12v8c0 6.2 4.3 11.5 10 13 5.7-1.5 10-6.8 10-13v-8L20 8Z'/%3e%3c/svg%3e",
        okx: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3crect width='40' height='40' rx='8' fill='black'/%3e%3crect x='10' y='10' width='8' height='8' fill='white'/%3e%3crect x='22' y='10' width='8' height='8' fill='white'/%3e%3crect x='10' y='22' width='8' height='8' fill='white'/%3e%3crect x='22' y='22' width='8' height='8' fill='white'/%3e%3c/svg%3e",
        phantom: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3crect width='40' height='40' rx='8' fill='%23AB9FF2'/%3e%3ccircle cx='20' cy='20' r='8' fill='white'/%3e%3c/svg%3e",
        generic: "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3e%3crect width='40' height='40' rx='8' fill='%23FF37C7'/%3e%3cpath fill='white' d='M12 16h16v2H12v-2Zm0 6h16v2H12v-2Z'/%3e%3c/svg%3e"
    };

    var RDNS_ICON = {
        "io.metamask": "metamask",
        "com.brave.wallet": "brave",
        "com.coinbase.wallet": "coinbase",
        "io.rabby": "rabby",
        "com.trustwallet.app": "trust",
        "com.okex.wallet": "okx",
        "app.phantom": "phantom"
    };

    var RDNS_LEGACY_ID = {
        "io.metamask": "metamask",
        "com.brave.wallet": "brave",
        "com.coinbase.wallet": "coinbase-extension",
        "io.rabby": "rabby",
        "com.trustwallet.app": "trust",
        "com.okex.wallet": "okx",
        "app.phantom": "phantom"
    };

    var LABEL_CLASS = "font_body _display-inline _boxSizing-border-box _whiteSpace-pre-wrap _mt-0px _mr-0px _mb-0px _ml-0px _color-neutral1 _fontFamily-f-family _wordWrap-break-word _fontSize-f-size-medi3736 _fontWeight-f-weight-bo3548 _lineHeight-f-lineHeigh507465454 _pt-t-space-spa94665593 _pb-t-space-spa94665593";
    var BADGE_CLASS = "font_body _display-inline _boxSizing-border-box _whiteSpace-pre-wrap _mt-0px _mr-0px _mb-0px _ml-0px _color-neutral2 _fontFamily-f-family _wordWrap-break-word _fontSize-12px _fontWeight-f-weight-bo3548 _lineHeight-16px";
    var SEPARATOR_CLASS = "_display-flex _alignItems-stretch _flexBasis-auto _boxSizing-border-box _position-relative _minHeight-0px _minWidth-0px _flexShrink-0 _flexDirection-column _height-2px _backgroundColor-surface1";
    var ROW_CLASS = "_backgroundColor-0hover-surface2Hov3121676 _display-flex _flexBasis-auto _boxSizing-border-box _minHeight-0px _minWidth-0px _flexShrink-0 _flexDirection-row _backgroundColor-surface2 _alignItems-center _width-10037 _justifyContent-space-betwe3241 _position-relative _pr-t-space-spa1360334080 _pl-t-space-spa1360334080 _pt-t-space-spa1360334080 _pb-t-space-spa1360334080 _cursor-pointer _opacity-1";

    function discoverEip6963Providers() {
        return new Promise(function(resolve) {
            var providers = [];
            var seen = {};

            function onAnnounce(event) {
                var detail = event.detail;
                if (!detail || !detail.info || !detail.provider) return;
                var key = detail.info.uuid || detail.info.rdns || detail.info.name;
                if (seen[key]) return;
                seen[key] = true;
                providers.push(detail);
            }

            window.addEventListener("eip6963:announceProvider", onAnnounce);
            window.dispatchEvent(new Event("eip6963:requestProvider"));

            setTimeout(function() {
                window.removeEventListener("eip6963:announceProvider", onAnnounce);
                resolve(providers);
            }, 500);
        });
    }

    function iconForWallet(info, fallbackKey) {
        if (info && info.icon) return info.icon;
        var key = (info && info.rdns && RDNS_ICON[info.rdns]) || fallbackKey || "generic";
        return ICONS[key] || ICONS.generic;
    }

    function walletFromEip6963(detail) {
        var rdns = detail.info.rdns;
        return {
            id: detail.info.uuid || rdns || detail.info.name,
            legacyId: RDNS_LEGACY_ID[rdns] || rdns || null,
            name: detail.info.name,
            icon: iconForWallet(detail.info, RDNS_ICON[rdns]),
            provider: detail.provider
        };
    }

    function detectLegacyProviders(existingIds) {
        var wallets = [];
        var seen = {};

        function addWallet(wallet) {
            if (!wallet || !wallet.provider || seen[wallet.id]) return;
            if (existingIds[wallet.id]) return;
            seen[wallet.id] = true;
            wallets.push(wallet);
        }

        function inspectProvider(provider) {
            if (!provider || typeof provider.request !== "function") return;

            if (provider.isBraveWallet) {
                addWallet({
                    id: "brave",
                    legacyId: "brave",
                    name: "Brave Wallet",
                    icon: ICONS.brave,
                    provider: provider
                });
                return;
            }

            if (provider.isRabby) {
                addWallet({
                    id: "rabby",
                    legacyId: "rabby",
                    name: "Rabby Wallet",
                    icon: ICONS.rabby,
                    provider: provider
                });
                return;
            }

            if (provider.isCoinbaseWallet || provider.isCoinbaseBrowser) {
                addWallet({
                    id: "coinbase-extension",
                    legacyId: "coinbase-extension",
                    name: "Coinbase Wallet",
                    icon: ICONS.coinbase,
                    provider: provider
                });
                return;
            }

            if (provider.isTrust || provider.isTrustWallet) {
                addWallet({
                    id: "trust",
                    legacyId: "trust",
                    name: "Trust Wallet",
                    icon: ICONS.trust,
                    provider: provider
                });
                return;
            }

            if (provider.isOkxWallet || provider.isOKExWallet || window.okxwallet) {
                addWallet({
                    id: "okx",
                    legacyId: "okx",
                    name: "OKX Wallet",
                    icon: ICONS.okx,
                    provider: provider
                });
                return;
            }

            if (provider.isMetaMask) {
                addWallet({
                    id: "metamask",
                    legacyId: "metamask",
                    name: "MetaMask",
                    icon: ICONS.metamask,
                    provider: provider
                });
                return;
            }

            if (provider.isPhantom) {
                addWallet({
                    id: "phantom",
                    legacyId: "phantom",
                    name: "Phantom",
                    icon: ICONS.phantom,
                    provider: provider
                });
            }
        }

        var ethereum = window.ethereum;
        if (!ethereum) return wallets;

        if (Array.isArray(ethereum.providers)) {
            ethereum.providers.forEach(inspectProvider);
        } else {
            inspectProvider(ethereum);
        }

        if (window.phantom && window.phantom.ethereum) {
            inspectProvider(window.phantom.ethereum);
        }

        if (window.coinbaseWalletExtension) {
            inspectProvider(window.coinbaseWalletExtension);
        }

        return wallets;
    }

    function mergeWallets(eip6963Details, legacyWallets) {
        var merged = [];
        var ids = {};

        eip6963Details.forEach(function(detail) {
            var wallet = walletFromEip6963(detail);
            if (ids[wallet.id]) return;
            ids[wallet.id] = true;
            merged.push(wallet);
        });

        legacyWallets.forEach(function(wallet) {
            if (ids[wallet.id]) return;
            ids[wallet.id] = true;
            merged.push(wallet);
        });

        return merged;
    }

    function createSeparator() {
        var separator = document.createElement("div");
        separator.className = SEPARATOR_CLASS;
        return separator;
    }

    function createDetectedRow(wallet) {
        var row = document.createElement("div");
        row.className = ROW_CLASS;
        row.setAttribute("data-testid", "detected-wallet");
        row.setAttribute("data-wallet-id", wallet.id);

        row.innerHTML =
            '<div class="_display-flex _flexBasis-auto _boxSizing-border-box _position-relative _minHeight-0px _minWidth-0px _flexShrink-0 _flexDirection-row _alignItems-center _gap-t-space-gap1569">' +
            '<img alt="' + wallet.name + '" src="' + wallet.icon + '" style="width: 32px; height: 32px; border-radius: 8px; border: 1px solid rgba(19, 19, 19, 0.08);">' +
            '<span maxfontsizemultiplier="1.4" data-disable-theme="true" class="' + LABEL_CLASS + '">' + wallet.name + '</span>' +
            "</div>" +
            '<div class="_display-flex _alignItems-stretch _flexBasis-auto _boxSizing-border-box _position-relative _minHeight-0px _minWidth-0px _flexShrink-0 _flexDirection-column">' +
            '<span maxfontsizemultiplier="1.4" data-disable-theme="true" class="' + BADGE_CLASS + '">Detected</span>' +
            "</div>";

        return row;
    }

    function renderDetectedWallets(optionGrid, wallets) {
        var anchor = optionGrid.querySelector('[data-testid="other-wallets"]');
        if (!anchor) return;

        optionGrid.querySelectorAll('[data-testid="detected-wallet"], [data-testid="detected-wallet-separator"]').forEach(function(node) {
            node.remove();
        });

        if (!wallets.length) return;

        var fragment = document.createDocumentFragment();
        wallets.forEach(function(wallet) {
            fragment.appendChild(createSeparator());
            var row = createDetectedRow(wallet);
            if (typeof window.walletModalBindDetectedWallet === "function") {
                window.walletModalBindDetectedWallet(row, wallet.legacyId || wallet.id, wallet.provider, wallet.name);
            }
            fragment.appendChild(row);
        });
        fragment.appendChild(createSeparator());

        optionGrid.insertBefore(fragment, anchor);
    }

    function notifyUpdated() {
        document.dispatchEvent(new CustomEvent("wallet-detect:updated"));
    }

    async function init() {
        var drawer = document.querySelector('[data-testid="account-drawer"]');
        if (!drawer) return;

        var optionGrid = drawer.querySelector('[data-testid="wallet-modal"] [data-testid="option-grid"]');
        if (!optionGrid) return;

        var eip6963 = await discoverEip6963Providers();
        var existingIds = {};
        eip6963.forEach(function(detail) {
            var wallet = walletFromEip6963(detail);
            existingIds[wallet.id] = true;
            if (detail.info.rdns) {
                existingIds[detail.info.rdns] = true;
                if (RDNS_LEGACY_ID[detail.info.rdns]) {
                    existingIds[RDNS_LEGACY_ID[detail.info.rdns]] = true;
                }
            }
        });

        var wallets = mergeWallets(eip6963, detectLegacyProviders(existingIds));
        renderDetectedWallets(optionGrid, wallets);
        notifyUpdated();
    }

    var LEGION_READY_RETRIES_MS = [500, 800, 1200, 2000];

    function bootDetect() {
        init().catch(function() { /* drawer not ready yet */ });
    }

    function scheduleLegionReadyRetries() {
        LEGION_READY_RETRIES_MS.forEach(function(delayMs) {
            setTimeout(bootDetect, delayMs);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bootDetect);
    } else {
        bootDetect();
    }

    window.addEventListener("legion:ready", scheduleLegionReadyRetries);

    document.addEventListener("wallet-detect:updated", function() {
        /* allow wallet-modal rebinding after bridge handlers install */
    });
})();