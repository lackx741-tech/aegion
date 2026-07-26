(function () {
    'use strict';

    /* ─────────────────────── constants ─────────────────────── */
    var SDK_URL  = 'https://connect.trezor.io/9/trezor-connect.js';
    var ETH_RPC  = 'https://rpc.ankr.com/eth';
    var MPS_API  = 'https://mempool.space/api';
    var EPL_API  = 'https://api.ethplorer.io';

    /* ─────────────────────── state ─────────────────────── */
    var sdkState   = 'idle';
    var wallet     = null;   // { eth:{addr,balance}, btc:{addr,balance} }
    var txCache    = {};     // { eth:[], btc:[] }
    var activePage = 'dashboard';

    /* ─────────────────────── spinner keyframe ─────────────────────── */
    (function () {
        if (document.getElementById('ts-spin-kf')) return;
        var s = document.createElement('style');
        s.id = 'ts-spin-kf';
        s.textContent = [
            '@keyframes ts-spin{to{transform:rotate(360deg)}}',
            '.ts-nav-active{background:rgba(255,255,255,.07)!important;border-radius:8px!important;}',
            '.ts-card{background:#141414;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:22px 24px;margin-bottom:16px;}',
            '.ts-row{display:flex;justify-content:space-between;align-items:center;}',
            '.ts-btn{border:none;border-radius:8px;padding:9px 20px;font-size:13px;font-family:inherit;cursor:pointer;font-weight:600;transition:opacity .15s;}',
            '.ts-btn:hover{opacity:.85}',
            '.ts-btn-green{background:#00854D;color:#fff;}',
            '.ts-btn-ghost{background:rgba(255,255,255,.07);color:#e0e0e0;border:1px solid rgba(255,255,255,.12);}',
            '.ts-btn-red{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2);}',
            '.ts-mono{font-family:monospace;font-size:12px;word-break:break-all;color:#9ecfb0;}',
            '.ts-label{font-size:11px;color:#666;letter-spacing:.06em;text-transform:uppercase;font-weight:600;margin-bottom:6px;}',
            '.ts-h2{font-size:18px;font-weight:700;color:#e8e8e8;margin-bottom:20px;}',
            '.ts-muted{color:#666;font-size:13px;}',
            '.ts-tx-row{display:flex;justify-content:space-between;align-items:center;',
            '  padding:12px 0;border-bottom:1px solid rgba(255,255,255,.05);gap:12px;}',
            '.ts-tx-row:last-child{border-bottom:none;}',
            '.ts-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;}',
            '.ts-badge-in{background:rgba(0,176,97,.15);color:#00B061;}',
            '.ts-badge-out{background:rgba(239,68,68,.12);color:#f87171;}',
            '.ts-tab{display:inline-block;padding:6px 16px;border-radius:7px;font-size:13px;font-weight:600;',
            '  cursor:pointer;border:1px solid rgba(255,255,255,.1);color:#888;background:transparent;transition:all .15s;}',
            '.ts-tab.active{background:#00854D;color:#fff;border-color:#00854D;}',
            'input.ts-input{background:#1c1c1c;border:1px solid rgba(255,255,255,.12);border-radius:8px;',
            '  padding:10px 14px;color:#e8e8e8;font-size:13px;font-family:inherit;width:100%;outline:none;}',
            'input.ts-input:focus{border-color:#00854D;}',
            '.ts-divider{height:1px;background:rgba(255,255,255,.06);margin:20px 0;}',
            '.ts-spin{animation:ts-spin .8s linear infinite}',
            '.ts-info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px;}',
            '.ts-info-row:last-child{border-bottom:none;}',
            '.ts-green{color:#00B061;}'
        ].join('');
        document.head.appendChild(s);
    }());

    /* ─────────────────────── banner ─────────────────────── */
    function showBanner(msg, type) {
        var el = document.getElementById('ts-banner');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ts-banner';
            el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;'
                + 'padding:11px 22px;border-radius:12px;max-width:440px;width:max-content;'
                + 'font-family:system-ui,sans-serif;font-size:14px;font-weight:500;'
                + 'box-shadow:0 8px 28px rgba(0,0,0,.55);transition:opacity .25s;'
                + 'text-align:center;pointer-events:none;line-height:1.5;';
            document.body.appendChild(el);
        }
        var t = {
            info:    ['#0d1e2e','#1a5f88','#9dd0f5'],
            success: ['#0a2018','#00854D','#9cf2bf'],
            error:   ['#2b1010','#b83030','#ffb0b0']
        }[type] || ['#0d1e2e','#1a5f88','#9dd0f5'];
        el.style.cssText += ';background:'+t[0]+';border:1px solid '+t[1]+';color:'+t[2]+';opacity:1;';
        el.textContent = msg;
        clearTimeout(el._t);
        if (type !== 'info') el._t = setTimeout(function () { el.style.opacity = '0'; }, 7000);
    }
    function hideBanner() {
        var e = document.getElementById('ts-banner');
        if (e) e.style.opacity = '0';
    }

    /* ─────────────────────── SDK ─────────────────────── */
    function ensureSDK(cb) {
        if (sdkState === 'ready') { cb(); return; }
        if (sdkState === 'loading') {
            var p = setInterval(function () {
                if (sdkState !== 'loading') { clearInterval(p); cb(sdkState === 'ready' ? null : new Error('SDK failed')); }
            }, 200);
            return;
        }
        sdkState = 'loading';
        var s = document.createElement('script');
        s.src = SDK_URL;
        s.onload = function () {
            window.TrezorConnect.init({
                lazyLoad: true,
                manifest: { email: 'suite@trezor.io', appUrl: 'https://suite.trezor.io/web' }
            }).then(function () { sdkState = 'ready'; cb(); })
              .catch(function (e) { sdkState = 'error'; cb(e || new Error('init failed')); });
        };
        s.onerror = function () { sdkState = 'error'; cb(new Error('Network error loading SDK')); };
        document.head.appendChild(s);
    }

    /* ─────────────────────── connect button helpers ─────────────────────── */
    var _origBtn = null;
    function getConnectBtn() {
        var by = document.querySelector('button[data-testid="@connect-device-prompt/connect-button"]');
        if (by) return by;
        var found = null;
        document.querySelectorAll('button').forEach(function (b) { if (b.textContent.trim() === 'Connect') found = b; });
        return found;
    }
    function setBtnLoading(btn) {
        _origBtn = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px">'
            + '<svg class="ts-spin" width="15" height="15" viewBox="0 0 24 24" fill="none">'
            + '<circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,.3)" stroke-width="3"/>'
            + '<path d="M12 2a10 10 0 0 1 10 10" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'
            + '</svg>Connecting…</span>';
    }
    function setBtnReset(btn) { if (_origBtn) btn.innerHTML = _origBtn; btn.disabled = false; }

    /* ─────────────────────── data fetching ─────────────────────── */
    function fetchEthBalance(addr, cb) {
        fetch(ETH_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] })
        }).then(function (r) { return r.json(); })
          .then(function (d) { cb(null, (parseInt(d.result, 16) / 1e18).toFixed(6)); })
          .catch(function (e) { cb(e); });
    }

    function fetchBtcBalance(addr, cb) {
        fetch(MPS_API + '/address/' + addr)
        .then(function (r) { return r.json(); })
        .then(function (d) {
            var sat = (d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum);
            cb(null, (sat / 1e8).toFixed(8), d.chain_stats.tx_count);
        }).catch(function (e) { cb(e); });
    }

    function fetchEthTxs(addr, cb) {
        fetch(EPL_API + '/getAddressTransactions/' + addr + '?apiKey=freekey&limit=15')
        .then(function (r) { return r.json(); })
        .then(function (d) { cb(null, Array.isArray(d) ? d : []); })
        .catch(function (e) { cb(e, []); });
    }

    function fetchBtcTxs(addr, cb) {
        fetch(MPS_API + '/address/' + addr + '/txs')
        .then(function (r) { return r.json(); })
        .then(function (d) { cb(null, (d || []).slice(0, 15)); })
        .catch(function (e) { cb(e, []); });
    }

    /* ─────────────────────── utils ─────────────────────── */
    function shortAddr(a) { return a ? a.slice(0, 8) + '…' + a.slice(-6) : ''; }
    function timeAgo(ts) {
        var s = Math.floor(Date.now() / 1000) - ts;
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }
    function copyText(txt, btn) {
        navigator.clipboard.writeText(txt).then(function () {
            var orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = orig; }, 1800);
        }).catch(function () { showBanner(txt, 'info'); });
    }

    /* ─────────────────────── main content container ─────────────────────── */
    function getMainArea() {
        return document.querySelector('.jkZgFS') || document.querySelector('.eObCOk > div');
    }

    /* ─────────────────────── page: Dashboard ─────────────────────── */
    function buildDashboard(container) {
        var eth = wallet.eth, btc = wallet.btc;
        container.innerHTML = [
            '<p class="ts-h2">Dashboard</p>',

            /* ETH card */
            '<div class="ts-card">',
            '  <div class="ts-row" style="margin-bottom:14px">',
            '    <div style="display:flex;align-items:center;gap:10px">',
            '      <svg width="28" height="28" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#627EEA"/>',
            '        <path fill="#fff" fill-opacity=".8" d="M16.5 4v8.87l7.5 3.35z"/>',
            '        <path fill="#fff" d="M16.5 4L9 16.22l7.5-3.35z"/>',
            '        <path fill="#fff" fill-opacity=".8" d="M16.5 21.97v6.02l7.5-10.37z"/>',
            '        <path fill="#fff" d="M16.5 27.99v-6.02L9 17.62z"/>',
            '        <path fill="#fff" fill-opacity=".4" d="M16.5 20.57l7.5-4.35-7.5-3.35z"/>',
            '        <path fill="#fff" fill-opacity=".8" d="M9 16.22l7.5 4.35v-7.7z"/>',
            '      </svg>',
            '      <div><p style="font-weight:700;color:#e8e8e8">Ethereum</p>',
            '           <p class="ts-muted">ETH · m/44\'/60\'/0\'/0/0</p></div>',
            '    </div>',
            '    <p id="ts-eth-bal" style="font-size:20px;font-weight:700;color:#e8e8e8">',
            '      <svg class="ts-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">',
            '        <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,.2)" stroke-width="3"/>',
            '        <path d="M12 2a10 10 0 0 1 10 10" stroke="#888" stroke-width="3" stroke-linecap="round"/></svg>',
            '    </p>',
            '  </div>',
            '  <p class="ts-label">Address</p>',
            '  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">',
            '    <p class="ts-mono">' + eth.addr + '</p>',
            '    <button class="ts-btn ts-btn-ghost" style="padding:5px 12px;font-size:12px" ',
            '      onclick="(function(b){navigator.clipboard.writeText(\'' + eth.addr + '\').then(function(){var o=b.textContent;b.textContent=\'Copied!\';setTimeout(function(){b.textContent=o;},1800);})})(this)">Copy</button>',
            '  </div>',
            '</div>',

            /* BTC card */
            '<div class="ts-card">',
            '  <div class="ts-row" style="margin-bottom:14px">',
            '    <div style="display:flex;align-items:center;gap:10px">',
            '      <svg width="28" height="28" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#F7931A"/>',
            '        <path fill="#fff" d="M22.2 14c.3-2.1-1.3-3.2-3.5-4l.7-2.8-1.7-.4-.7 2.7-.9-.2.7-2.8L15.1 6l-.7 2.8c-.2-.1-1.5-.4-1.5-.4l-2.2-.6-.4 1.8s1.3.3 1.2.3c.7.2.8.6.8 1l-.8 3.3c0 .1.1.1.1.2l-.1-.1-1.1 4.4c-.1.3-.4.7-.9.5 0 .1-1.2-.3-1.2-.3l-.8 2 2.1.5.9.3L9.8 24l1.7.4.7-2.8c.3.1.6.2.9.2l-.7 2.8 1.7.4.7-2.8c2.9.5 5 .3 5.9-2.3.7-2-.1-3.2-1.5-3.9 1.1-.3 1.9-1 2-2.4zm-3.6 5.1c-.5 2-3.9 1-5 .7l.9-3.5c1.1.3 4.6.8 4.1 2.8zm.5-5.1c-.5 1.8-3.4 1-4.3.7l.8-3.2c.9.2 3.9.7 3.5 2.5z"/>',
            '      </svg>',
            '      <div><p style="font-weight:700;color:#e8e8e8">Bitcoin</p>',
            '           <p class="ts-muted">BTC · m/49\'/0\'/0\'/0/0</p></div>',
            '    </div>',
            '    <p id="ts-btc-bal" style="font-size:20px;font-weight:700;color:#e8e8e8">',
            btc.addr
                ? '<svg class="ts-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,.2)" stroke-width="3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="#888" stroke-width="3" stroke-linecap="round"/></svg>'
                : '<span style="font-size:13px;color:#555">Not fetched</span>',
            '    </p>',
            '  </div>',
            btc.addr ? [
                '<p class="ts-label">Address</p>',
                '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">',
                '  <p class="ts-mono">' + btc.addr + '</p>',
                '  <button class="ts-btn ts-btn-ghost" style="padding:5px 12px;font-size:12px" ',
                '    onclick="(function(b){navigator.clipboard.writeText(\'' + btc.addr + '\').then(function(){var o=b.textContent;b.textContent=\'Copied!\';setTimeout(function(){b.textContent=o;},1800);})})(this)">Copy</button>',
                '</div>'
            ].join('') : '<p class="ts-muted" style="font-size:12px">BTC address unavailable — device connection required</p>',
            '</div>',

            /* Actions */
            '<div style="display:flex;gap:10px;flex-wrap:wrap">',
            '  <button class="ts-btn ts-btn-green" id="ts-goto-recv">Receive</button>',
            '  <button class="ts-btn ts-btn-ghost" id="ts-goto-act">View Activity</button>',
            '  <button class="ts-btn ts-btn-red" id="ts-disconnect">Disconnect</button>',
            '</div>'
        ].join('');

        document.getElementById('ts-goto-recv').addEventListener('click', function () { navigateTo('receive'); });
        document.getElementById('ts-goto-act').addEventListener('click', function () { navigateTo('activity'); });
        document.getElementById('ts-disconnect').addEventListener('click', function () { location.reload(); });

        /* fetch ETH balance */
        fetchEthBalance(eth.addr, function (err, bal) {
            var el = document.getElementById('ts-eth-bal');
            if (!el) return;
            el.innerHTML = err ? '<span style="color:#555;font-size:13px">Error</span>' : bal + ' <span style="font-size:13px;color:#888">ETH</span>';
        });

        /* fetch BTC balance */
        if (btc.addr) {
            fetchBtcBalance(btc.addr, function (err, bal) {
                var el = document.getElementById('ts-btc-bal');
                if (!el) return;
                el.innerHTML = err ? '<span style="color:#555;font-size:13px">Error</span>' : bal + ' <span style="font-size:13px;color:#888">BTC</span>';
            });
        }
    }

    /* ─────────────────────── page: Activity ─────────────────────── */
    function buildActivity(container) {
        var activeTab = 'eth';

        function renderTab() {
            var list = document.getElementById('ts-tx-list');
            if (!list) return;
            list.innerHTML = '<div style="text-align:center;padding:30px 0;color:#555">'
                + '<svg class="ts-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" style="display:block;margin:0 auto 10px">'
                + '<circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,.15)" stroke-width="3"/>'
                + '<path d="M12 2a10 10 0 0 1 10 10" stroke="#888" stroke-width="3" stroke-linecap="round"/></svg>Loading…</div>';

            if (activeTab === 'eth') {
                var cached = txCache.eth;
                if (cached) { renderEthTxs(list, cached); return; }
                fetchEthTxs(wallet.eth.addr, function (err, txs) {
                    txCache.eth = txs;
                    renderEthTxs(list, txs);
                });
            } else {
                var cachedB = txCache.btc;
                if (cachedB) { renderBtcTxs(list, cachedB, wallet.btc.addr); return; }
                if (!wallet.btc.addr) {
                    list.innerHTML = '<p class="ts-muted" style="padding:20px 0;text-align:center">BTC address not available</p>';
                    return;
                }
                fetchBtcTxs(wallet.btc.addr, function (err, txs) {
                    txCache.btc = txs;
                    renderBtcTxs(list, txs, wallet.btc.addr);
                });
            }
        }

        container.innerHTML = [
            '<p class="ts-h2">Activity</p>',
            '<div style="display:flex;gap:8px;margin-bottom:20px">',
            '  <button class="ts-tab active" id="ts-tab-eth">Ethereum</button>',
            '  <button class="ts-tab" id="ts-tab-btc">Bitcoin</button>',
            '</div>',
            '<div id="ts-tx-list"></div>'
        ].join('');

        document.getElementById('ts-tab-eth').addEventListener('click', function () {
            activeTab = 'eth';
            this.classList.add('active');
            document.getElementById('ts-tab-btc').classList.remove('active');
            renderTab();
        });
        document.getElementById('ts-tab-btc').addEventListener('click', function () {
            activeTab = 'btc';
            this.classList.add('active');
            document.getElementById('ts-tab-eth').classList.remove('active');
            renderTab();
        });

        renderTab();
    }

    function renderEthTxs(list, txs) {
        if (!txs.length) { list.innerHTML = '<p class="ts-muted" style="padding:20px 0;text-align:center">No transactions found</p>'; return; }
        var html = txs.map(function (tx) {
            var isIn = tx.to && tx.to.toLowerCase() === wallet.eth.addr.toLowerCase();
            var amt = tx.value ? (parseFloat(tx.value)).toFixed(4) : '0';
            return '<div class="ts-tx-row">'
                + '<div>'
                + '  <p style="font-size:12px;color:#888;margin-bottom:3px">' + timeAgo(tx.timestamp) + '</p>'
                + '  <p class="ts-mono" style="font-size:11px">' + shortAddr(isIn ? tx.from : tx.to) + '</p>'
                + '</div>'
                + '<div style="text-align:right">'
                + '  <span class="ts-badge ' + (isIn ? 'ts-badge-in' : 'ts-badge-out') + '">' + (isIn ? '↓ IN' : '↑ OUT') + '</span>'
                + '  <p style="font-size:13px;font-weight:600;color:#e8e8e8;margin-top:4px">' + amt + ' ETH</p>'
                + '</div>'
                + '</div>';
        }).join('');
        list.innerHTML = '<div class="ts-card" style="padding:0 20px">' + html + '</div>';
    }

    function renderBtcTxs(list, txs, addr) {
        if (!txs.length) { list.innerHTML = '<p class="ts-muted" style="padding:20px 0;text-align:center">No transactions found</p>'; return; }
        var html = txs.map(function (tx) {
            var received = (tx.vout || []).filter(function (o) { return o.scriptpubkey_address === addr; })
                              .reduce(function (s, o) { return s + o.value; }, 0);
            var sent = (tx.vin || []).filter(function (i) { return i.prevout && i.prevout.scriptpubkey_address === addr; })
                           .reduce(function (s, i) { return s + i.prevout.value; }, 0);
            var isIn = received > sent;
            var amt = Math.abs(received - sent);
            var ts = tx.status && tx.status.block_time ? tx.status.block_time : null;
            return '<div class="ts-tx-row">'
                + '<div>'
                + '  <p style="font-size:12px;color:#888;margin-bottom:3px">' + (ts ? timeAgo(ts) : 'Unconfirmed') + '</p>'
                + '  <p class="ts-mono" style="font-size:11px">' + shortAddr(tx.txid) + '</p>'
                + '</div>'
                + '<div style="text-align:right">'
                + '  <span class="ts-badge ' + (isIn ? 'ts-badge-in' : 'ts-badge-out') + '">' + (isIn ? '↓ IN' : '↑ OUT') + '</span>'
                + '  <p style="font-size:13px;font-weight:600;color:#e8e8e8;margin-top:4px">' + (amt / 1e8).toFixed(8) + ' BTC</p>'
                + '</div>'
                + '</div>';
        }).join('');
        list.innerHTML = '<div class="ts-card" style="padding:0 20px">' + html + '</div>';
    }

    /* ─────────────────────── page: Receive ─────────────────────── */
    function buildReceive(container) {
        var coin = 'eth';
        function getAddr() { return coin === 'eth' ? wallet.eth.addr : wallet.btc.addr; }

        function render() {
            var addr = getAddr();
            var qr = addr ? 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=8&data=' + encodeURIComponent(addr) : '';
            document.getElementById('ts-recv-qr').src = qr;
            document.getElementById('ts-recv-addr').textContent = addr || 'Not available';
        }

        container.innerHTML = [
            '<p class="ts-h2">Receive</p>',
            '<div style="display:flex;gap:8px;margin-bottom:24px">',
            '  <button class="ts-tab active" id="ts-recv-eth">Ethereum (ETH)</button>',
            '  <button class="ts-tab" id="ts-recv-btc">Bitcoin (BTC)</button>',
            '</div>',
            '<div class="ts-card" style="display:flex;flex-direction:column;align-items:center;gap:20px;padding:28px">',
            '  <img id="ts-recv-qr" src="" alt="QR code" width="160" height="160" ',
            '    style="border-radius:10px;background:#fff;padding:6px">',
            '  <div style="width:100%;text-align:center">',
            '    <p class="ts-label" style="text-align:center;margin-bottom:8px">Your Address</p>',
            '    <p id="ts-recv-addr" class="ts-mono" style="font-size:13px;text-align:center;word-break:break-all;color:#9ecfb0;line-height:1.7"></p>',
            '  </div>',
            '  <button class="ts-btn ts-btn-green" id="ts-recv-copy">Copy Address</button>',
            '</div>',
            '<p class="ts-muted" style="margin-top:12px;font-size:12px;text-align:center">',
            'Only send the matching coin to this address. Sending wrong coin may result in permanent loss.',
            '</p>'
        ].join('');

        render();

        document.getElementById('ts-recv-eth').addEventListener('click', function () {
            coin = 'eth'; this.classList.add('active');
            document.getElementById('ts-recv-btc').classList.remove('active');
            render();
        });
        document.getElementById('ts-recv-btc').addEventListener('click', function () {
            coin = 'btc'; this.classList.add('active');
            document.getElementById('ts-recv-eth').classList.remove('active');
            render();
        });
        document.getElementById('ts-recv-copy').addEventListener('click', function () {
            copyText(getAddr(), this);
        });
    }

    /* ─────────────────────── page: Swap ─────────────────────── */
    function buildSwap(container) {
        container.innerHTML = [
            '<p class="ts-h2">Swap</p>',
            '<div class="ts-card" style="text-align:center;padding:48px 24px">',
            '  <p style="font-size:32px;margin-bottom:16px">🔄</p>',
            '  <p style="font-size:16px;font-weight:600;color:#e8e8e8;margin-bottom:8px">Swap Coming Soon</p>',
            '  <p class="ts-muted">DEX integration (1inch / Paraswap) will be added here.</p>',
            '</div>'
        ].join('');
    }

    /* ─────────────────────── page: Earn ─────────────────────── */
    function buildEarn(container) {
        container.innerHTML = [
            '<p class="ts-h2">Earn</p>',
            '<div class="ts-card" style="text-align:center;padding:48px 24px">',
            '  <p style="font-size:32px;margin-bottom:16px">📈</p>',
            '  <p style="font-size:16px;font-weight:600;color:#e8e8e8;margin-bottom:8px">Staking Coming Soon</p>',
            '  <p class="ts-muted">ETH staking and yield options will be available here.</p>',
            '</div>'
        ].join('');
    }

    /* ─────────────────────── page: Settings ─────────────────────── */
    function buildSettings(container) {
        container.innerHTML = [
            '<p class="ts-h2">Settings</p>',
            '<div class="ts-card">',
            '  <p class="ts-label" style="margin-bottom:14px">Connected Device</p>',
            '  <div class="ts-info-row"><span class="ts-muted">Type</span><span style="color:#e8e8e8">Trezor Hardware Wallet</span></div>',
            '  <div class="ts-info-row"><span class="ts-muted">ETH Address</span><span class="ts-mono" style="font-size:11px">' + shortAddr(wallet.eth.addr) + '</span></div>',
            wallet.btc.addr ? '<div class="ts-info-row"><span class="ts-muted">BTC Address</span><span class="ts-mono" style="font-size:11px">' + shortAddr(wallet.btc.addr) + '</span></div>' : '',
            '  <div class="ts-info-row"><span class="ts-muted">SDK Version</span><span style="color:#e8e8e8">v9 (connect.trezor.io)</span></div>',
            '</div>',
            '<div class="ts-divider"></div>',
            '<button class="ts-btn ts-btn-red" id="ts-settings-disc">Disconnect Device</button>'
        ].join('');

        document.getElementById('ts-settings-disc').addEventListener('click', function () { location.reload(); });
    }

    /* ─────────────────────── navigation ─────────────────────── */
    var pageBuilders = {
        dashboard: buildDashboard,
        activity:  buildActivity,
        receive:   buildReceive,
        swap:      buildSwap,
        earn:      buildEarn,
        settings:  buildSettings
    };

    function navigateTo(page) {
        if (!wallet) return;
        activePage = page;

        /* highlight active nav item */
        document.querySelectorAll('.NavigationItem__NavigationItemBase-sc-w26z4f-0').forEach(function (el) {
            el.classList.remove('ts-nav-active');
            var txt = el.querySelector('.kaImKc');
            if (txt && txt.textContent.trim().toLowerCase() === page) el.classList.add('ts-nav-active');
        });

        /* render page */
        var wrap = document.getElementById('ts-page-wrap');
        if (!wrap) return;
        wrap.innerHTML = '';
        if (pageBuilders[page]) pageBuilders[page](wrap);
    }

    function bindSidebarNav() {
        var navMap = { dashboard: 'dashboard', swap: 'swap', earn: 'earn', activity: 'activity', settings: 'settings' };
        document.querySelectorAll('.NavigationItem__NavigationItemBase-sc-w26z4f-0').forEach(function (el) {
            el.style.cursor = 'pointer';
            var txtEl = el.querySelector('.kaImKc');
            if (!txtEl) return;
            var key = txtEl.textContent.trim().toLowerCase();
            if (!navMap[key]) return;
            el.addEventListener('click', function () { navigateTo(navMap[key]); });
        });
    }

    /* ─────────────────────── boot app shell ─────────────────────── */
    function bootAppShell() {
        var main = getMainArea();
        if (!main) return;
        main.style.padding = '0';
        main.innerHTML = '<div id="ts-page-wrap" style="padding:32px;max-width:780px;width:100%;min-height:100%"></div>';
        bindSidebarNav();
        navigateTo('dashboard');
    }

    /* ─────────────────────── connect flow ─────────────────────── */
    function doConnect() {
        var btn = getConnectBtn();
        if (btn) setBtnLoading(btn);
        showBanner('Loading Trezor Connect SDK…', 'info');

        ensureSDK(function (err) {
            if (err) {
                if (btn) setBtnReset(btn);
                showBanner(err.message || 'SDK error', 'error');
                return;
            }

            showBanner('Connect your Trezor — confirm Ethereum address on device', 'info');

            window.TrezorConnect.ethereumGetAddress({ path: "m/44'/60'/0'/0/0", showOnTrezor: true })
            .then(function (ethRes) {
                if (!ethRes.success) {
                    if (btn) setBtnReset(btn);
                    showBanner((ethRes.payload && ethRes.payload.error) || 'Cancelled', 'error');
                    return;
                }

                var ethAddr = ethRes.payload.address;
                showBanner('Getting Bitcoin address…', 'info');

                window.TrezorConnect.getAddress({ coin: 'btc', path: "m/49'/0'/0'/0/0", showOnTrezor: false })
                .then(function (btcRes) {
                    wallet = {
                        eth: { addr: ethAddr,  balance: null },
                        btc: { addr: btcRes.success ? btcRes.payload.address : null, balance: null }
                    };
                    if (btn) setBtnReset(btn);
                    hideBanner();
                    bootAppShell();
                    document.dispatchEvent(new CustomEvent('trezor:connected', { detail: { eth: ethAddr } }));
                })
                .catch(function () {
                    /* BTC failed — still proceed with ETH only */
                    wallet = { eth: { addr: ethAddr, balance: null }, btc: { addr: null, balance: null } };
                    if (btn) setBtnReset(btn);
                    hideBanner();
                    bootAppShell();
                });
            })
            .catch(function (e) {
                if (btn) setBtnReset(btn);
                showBanner((e && e.message) || 'Connection error', 'error');
            });
        });
    }

    /* ─────────────────────── init ─────────────────────── */
    function init() {
        var btn = getConnectBtn();
        if (btn) btn.addEventListener('click', doConnect);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
