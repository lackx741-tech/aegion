/**
 * MUST load before legion-wallet.iife.js — fixes WC relay "unknown payload: 123,34,106..."
 * v1.1.0 — Buffer + Uint8Array; JSON patch installed by LegionWallet during WC session only.
 */
(function installLegionPolyfillsEarly() {
  if (typeof globalThis !== 'undefined' && globalThis.__LEGION_POLYFILLS__) return;
  if (typeof globalThis !== 'undefined') globalThis.__LEGION_POLYFILLS__ = true;

  if (typeof process === 'undefined' || !process.nextTick) {
    var g = typeof globalThis !== 'undefined' ? globalThis : window;
    g.process = {
      env: { NODE_ENV: 'production' },
      version: '',
      browser: true,
      nextTick: function (fn, a, b) { Promise.resolve().then(function () { fn(a, b); }); },
    };
    try { if (typeof g.process.setMaxListeners === 'function') g.process.setMaxListeners(32); } catch (_) {}
  }

  if (typeof global === 'undefined' && typeof window !== 'undefined') window.global = window;

  function utf8FromU8(u8) {
    try { return new TextDecoder('utf-8').decode(u8); }
    catch (_) {
      var s = '';
      for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return s;
    }
  }

  function attachBuf(u8) {
    if (!u8 || u8.__legionBuf) return u8;
    try { Object.defineProperty(u8, '__legionBuf', { value: true, enumerable: false }); }
    catch (_) { u8.__legionBuf = true; }
    u8.toString = function toString(enc) {
      enc = enc || 'utf8';
      if (enc === 'hex') {
        return Array.prototype.map.call(this, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      }
      if (enc === 'base64') {
        var bin = '';
        for (var i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
        return btoa(bin);
      }
      return utf8FromU8(this);
    };
    return u8;
  }

  if (!Uint8Array.prototype.__legionU8ToString) {
    Uint8Array.prototype.toString = function patchedU8ToString() {
      if (this.__legionBuf) return attachBuf(this).toString('utf8');
      return utf8FromU8(this);
    };
    Uint8Array.prototype.__legionU8ToString = true;
  }

  var root = typeof globalThis !== 'undefined' ? globalThis : window;
  if (typeof root.Buffer === 'undefined' || !root.Buffer.from || root.Buffer.from('ab').toString() !== 'ab') {
    root.Buffer = {
      isBuffer: function (b) { return !!(b && (b instanceof Uint8Array || b.__legionBuf)); },
      from: function (d, enc) {
        if (typeof d === 'string') {
          if (enc === 'hex') {
            var s = d.length % 2 ? '0' + d : d, bytes = [];
            for (var i = 0; i < s.length; i += 2) bytes.push(parseInt(s.substr(i, 2), 16));
            return attachBuf(new Uint8Array(bytes));
          }
          if (enc === 'base64') {
            var bin = atob(d), u = new Uint8Array(bin.length);
            for (var j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
            return attachBuf(u);
          }
          return attachBuf(new TextEncoder().encode(d));
        }
        if (d instanceof ArrayBuffer) return attachBuf(new Uint8Array(d));
        if (ArrayBuffer.isView(d)) return attachBuf(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
        return attachBuf(new Uint8Array(d));
      },
      alloc: function (n, fill) {
        var a = new Uint8Array(n);
        if (fill !== undefined) a.fill(fill);
        return attachBuf(a);
      },
      concat: function (list, totalLength) {
        var total = totalLength != null ? totalLength : list.reduce(function (s, b) { return s + b.length; }, 0);
        var out = new Uint8Array(total), off = 0;
        list.forEach(function (b) {
          var view = b instanceof Uint8Array ? b : new Uint8Array(b);
          out.set(view, off); off += view.length;
        });
        return attachBuf(out);
      },
      byteLength: function (s, enc) {
        if (typeof s === 'string') return root.Buffer.from(s, enc).length;
        return s.length;
      },
    };
  }

  /** Shared replacer for WC relay — used by LegionWallet.installWcJsonPatch */
  root.__LEGION_WC_JSON_REPLACER__ = function legionWcJsonReplacer(key, val) {
    if (val instanceof Uint8Array) {
      return { type: 'Buffer', data: Array.prototype.slice.call(val) };
    }
    if (val && val.constructor && val.constructor.name === 'Uint8Array' && typeof val.length === 'number') {
      return { type: 'Buffer', data: Array.prototype.slice.call(val) };
    }
    return val;
  };
})();
