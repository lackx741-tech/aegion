/**
 * Exodus skin — distinct Pay-style UX (not Trust recolor).
 */
(function () {
  'use strict';

  var LOGO = '/logo.svg?v=4';
  var BRAND = 'Exodus';
  var applying = false;
  var timer = null;

  function ensureOrbit() {
    if (document.getElementById('exo-orbit')) return;
    var o = document.createElement('div');
    o.id = 'exo-orbit';
    o.innerHTML = '<div class="orb orb-a"></div><div class="orb orb-b"></div><div class="orb orb-c"></div>';
    document.body.insertBefore(o, document.body.firstChild);
  }

  function swapImgs(root) {
    var imgs = (root || document).querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = (img.getAttribute('src') || '') + ' ' + (img.getAttribute('alt') || '');
      var cls = img.className || '';
      var parentCls = String((img.parentElement && img.parentElement.className) || '');
      // Replace any TrustWallet CDN image used as Exodus wallet icon
      if (/trustwallet/i.test(img.getAttribute('src') || '')) {
        img.setAttribute('src', LOGO);
        img.setAttribute('alt', 'Exodus');
        continue;
      }
      if (
        /logo|favicon|trust|brand|hdr|footer|exodus/i.test(src + ' ' + cls) ||
        (img.width <= 64 && img.height <= 64 && /hdr|footer|logo/i.test(parentCls))
      ) {
        if (img.getAttribute('src') !== LOGO) {
          img.setAttribute('src', LOGO);
          img.setAttribute('alt', 'Exodus');
        }
      }
    }
  }

  function fixLinks(root) {
    var links = (root || document).querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (/trustwallet/i.test(href)) {
        var newHref = href
          .replace(/support@trustwallet\.com/gi, 'support@exodus.com')
          .replace(/legal@trustwallet\.com/gi, 'legal@exodus.com')
          .replace(/privacy@trustwallet\.com/gi, 'privacy@exodus.com')
          .replace(/trustwallet\.com/gi, 'exodus.com');
        links[i].setAttribute('href', newHref);
        var txt = links[i].textContent || '';
        if (/trustwallet/i.test(txt)) {
          links[i].textContent = txt.replace(/trustwallet\.com/gi, 'exodus.com');
        }
      }
    }
  }

  function fixText(node) {
    if (!node || node.nodeType !== 3) return;
    var t = node.nodeValue;
    if (!t) return;
    var n = t
      .replace(/Trust\s*Wallet\s*Card/gi, 'Exodus Card')
      .replace(/Trust\s*Wallet/gi, 'Exodus')
      .replace(/TrustWallet/gi, 'Exodus')
      .replace(/©\s*2026\s*TrustWallet/gi, '© 2026 Exodus')
      .replace(/©2026 TrustWallet/gi, '© 2026 Exodus')
      .replace(/powered by Trust/gi, 'powered by Exodus');
    if (n !== t) node.nodeValue = n;
  }

  function walk(el) {
    if (!el) return;
    if (el.nodeType === 3) {
      fixText(el);
      return;
    }
    if (el.nodeType !== 1) return;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  }

  function brandHeader() {
    var texts = document.querySelectorAll('.hdr-logo-text, .hdr-center-text, .footer-brand');
    for (var i = 0; i < texts.length; i++) {
      if (texts[i].textContent !== BRAND) texts[i].textContent = BRAND;
    }
    var logoBtns = document.querySelectorAll('.hdr-logo, .footer-logo');
    for (var j = 0; j < logoBtns.length; j++) {
      if (logoBtns[j].getAttribute('aria-label') !== 'Exodus home') {
        logoBtns[j].setAttribute('aria-label', 'Exodus home');
      }
    }
  }

  function styleBadge() {
    var badges = document.querySelectorAll('.badge-early');
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      if (b.dataset.exoKick === '1') continue;
      b.dataset.exoKick = '1';
      b.classList.add('exo-kicker');
      var txt = (b.textContent || '').trim();
      b.innerHTML =
        '<img src="' + LOGO + '" alt="" />' +
        '<span>' + (txt || 'Built on self-custody') + '</span>';
    }
  }

  function mintHeroAccent() {
    var h1 = document.querySelector('h1, .welcome-title');
    if (!h1 || h1.dataset.exoMint === '1') return;
    var span = h1.querySelector('span');
    if (span) {
      span.style.color = '#bbfbe0';
      h1.dataset.exoMint = '1';
      return;
    }
    // Last word → mint (Exodus Pay “Truly.” pattern)
    var html = h1.innerHTML;
    if (!html || html.indexOf('<') !== -1) return;
    var parts = html.trim().split(/\s+/);
    if (parts.length < 2) return;
    var last = parts.pop();
    h1.innerHTML = parts.join(' ') + ' <span style="color:#bbfbe0">' + last + '</span>';
    h1.dataset.exoMint = '1';
  }

  function sectionLabels() {
    var feats = document.querySelector('.feat-sec');
    if (feats && !document.querySelector('.exo-section-label[data-for="feats"]')) {
      var lab = document.createElement('div');
      lab.className = 'exo-section-label';
      lab.setAttribute('data-for', 'feats');
      lab.textContent = 'Why Exodus Card';
      feats.parentNode.insertBefore(lab, feats);
    }
    var faq = document.querySelector('details.faq, h2');
    var faqH = null;
    var hs = document.querySelectorAll('h2');
    for (var i = 0; i < hs.length; i++) {
      if (/FAQ|question/i.test(hs[i].textContent || '')) faqH = hs[i];
    }
    if (faqH && !faqH.dataset.exoLabel) {
      faqH.dataset.exoLabel = '1';
      faqH.style.fontFamily = "'Space Grotesk', Outfit, sans-serif";
      faqH.style.letterSpacing = '-0.02em';
    }
  }

  function paintMiniCards() {
    var cards = document.querySelectorAll('.mini-card');
    for (var i = 0; i < cards.length; i++) {
      var spans = cards[i].querySelectorAll('span');
      for (var j = 0; j < spans.length; j++) {
        if ((spans[j].textContent || '').trim() === 'TRUST') spans[j].textContent = 'EXODUS';
      }
      if (cards[i].dataset.exoCard === '1') continue;
      cards[i].dataset.exoCard = '1';
    }
  }

  function hideTrustScarcity() {
    var nodes = document.querySelectorAll('.prog-num, .prog-track, .prog-bar, .prog-label');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].style.display = 'none';
      var p = nodes[i].parentElement;
      if (p && /prog/i.test(p.className || '')) p.style.display = 'none';
    }
  }

  function apply() {
    if (applying) return;
    applying = true;
    try {
      if (document.title !== 'Exodus Card') document.title = 'Exodus Card';
      ensureOrbit();
      swapImgs(document);
      brandHeader();
      walk(document.body);
      styleBadge();
      mintHeroAccent();
      sectionLabels();
      paintMiniCards();
      hideTrustScarcity();
      fixLinks(document);
    } finally {
      applying = false;
    }
  }

  function schedule() {
    if (applying) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, 90);
  }

  var obs = new MutationObserver(schedule);

  function boot() {
    apply();
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
  setTimeout(apply, 280);
  setTimeout(apply, 1000);
})();
