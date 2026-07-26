const fs = require('fs');

let content = fs.readFileSync('index.html', 'utf8');

// ===== 1. Remove React script to prevent re-hydration =====
content = content.replace(
  /<script defer src="\.\/scripts\/[^"]+"\s*integrity="[^"]*"><\/script>/g,
  '<!-- React script removed for static clone -->'
);

// ===== 2. Remove the existing incomplete custom styles (line 20) =====
content = content.replace(
  /<style>\.css-3pnm6m \{ display: none !important; \}[^<]*<\/style>/,
  ''
);

// ===== 3. Inject nav links into header (between logo and right-side) =====
const navHTML = `<nav class="swapx-nav">
  <a href="./pages/page.html">Swap</a>
  <a href="./pages/earn.html">Earn</a>
  <a href="./pages/vote.html">Voting</a>
  <a href="./pages/xnft.html">xNFT</a>
  <a href="./pages/presale.html" class="nav-highlight">xNFT Lounge</a>
  <a href="./pages/cross-chain.html">Cross Chain</a>
  <div class="nav-more-btn">
    More
    <div class="nav-more-dropdown">
      <a href="https://swapxfi.gitbook.io/swapx-docs" target="_blank">Docs</a>
      <a href="https://twitter.com/swapxfi" target="_blank">X (Twitter)</a>
      <a href="https://t.me/swapxfi" target="_blank">Telegram</a>
      <a href="https://medium.com/@swapxfi" target="_blank">Medium</a>
      <a href="https://discord.gg/yXU4HMsp6P" target="_blank">Discord</a>
    </div>
  </div>
</nav>`;

// Inject between logo container (css-rvp98e closing div) and right side (css-1igwmid)
content = content.replace(
  /(class="css-rvp98e">[^<]*(?:<[^>]+>[^<]*<\/[^>]+>)*<\/div>)(<div class="chakra-stack css-1igwmid")/,
  (match, logoEnd, rightStart) => {
    return logoEnd + navHTML + rightStart;
  }
);

// Simpler regex approach for the injection
if (!content.includes('swapx-nav')) {
  // Try a different approach
  const logoAreaEnd = '</div><div class="chakra-stack css-1igwmid"';
  const logoAreaReplace = `</div>${navHTML}<div class="chakra-stack css-1igwmid"`;

  // Find in header context
  const headerIdx = content.indexOf('<header class="css-yesj0r">');
  const headerEndIdx = content.indexOf('</header>', headerIdx);
  const headerSection = content.substring(headerIdx, headerEndIdx);

  if (headerSection.includes(logoAreaEnd)) {
    const fixedHeader = headerSection.replace(logoAreaEnd, logoAreaReplace);
    content = content.substring(0, headerIdx) + fixedHeader + content.substring(headerEndIdx);
  }
}

// ===== 4. Add comprehensive CSS fixes before </head> =====
const cssfix = `
<style id="swapx-fix">
/* ===== LAYOUT FIXES ===== */

/* Hide legal disclaimer completely */
.css-1hi9xxy,
.css-3pnm6m,
.hide { display: none !important; }

/* Hide any remaining modal overlays */
[class*="modal"],
[class*="overlay"],
[class*="backdrop"],
.css-1c07urp { display: none !important; }

/* Fix body */
body { overflow-x: hidden; }

/* ===== HEADER / NAVBAR ===== */
header.css-yesj0r {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  height: 70px !important;
  background: #0b0f17 !important;
  border-bottom: 1px solid rgba(255,255,255,0.07) !important;
  z-index: 100 !important;
  display: flex !important;
  align-items: center !important;
  padding: 0 !important;
}

.css-3jm7jv {
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  width: 100% !important;
  max-width: 1400px !important;
  margin: 0 auto !important;
  padding: 0 24px !important;
  gap: 24px !important;
}

/* Logo container */
.css-rvp98e {
  display: flex !important;
  align-items: center !important;
  flex-shrink: 0 !important;
  height: 40px !important;
  overflow: hidden !important;
}

.css-rvp98e a,
.css-rvp98e svg {
  height: 27px !important;
  width: auto !important;
  max-height: 27px !important;
  display: block !important;
}

/* Nav links */
.swapx-nav {
  display: flex !important;
  align-items: center !important;
  gap: 4px !important;
  flex: 1 !important;
  justify-content: center !important;
}

.swapx-nav a, .swapx-nav .nav-more-btn {
  color: rgba(255,255,255,0.85) !important;
  font-size: 14px !important;
  font-weight: 500 !important;
  padding: 6px 12px !important;
  border-radius: 6px !important;
  text-decoration: none !important;
  white-space: nowrap !important;
  cursor: pointer !important;
  transition: background 0.2s, color 0.2s !important;
  font-family: Inter, sans-serif !important;
}

.swapx-nav a:hover, .swapx-nav .nav-more-btn:hover {
  background: rgba(255,255,255,0.08) !important;
  color: #fff !important;
}

.swapx-nav .nav-highlight {
  color: #9AEF4B !important;
}

.swapx-nav .nav-highlight:hover {
  background: rgba(154,239,75,0.1) !important;
}

/* More dropdown */
.nav-more-btn {
  position: relative !important;
  user-select: none !important;
  display: flex !important;
  align-items: center !important;
  gap: 4px !important;
}

.nav-more-btn::after {
  content: '▾' !important;
  font-size: 10px !important;
}

.nav-more-dropdown {
  display: none;
  position: absolute !important;
  top: calc(100% + 8px) !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  background: #141915 !important;
  border: 1px solid rgba(255,255,255,0.1) !important;
  border-radius: 12px !important;
  padding: 8px !important;
  min-width: 160px !important;
  z-index: 200 !important;
  flex-direction: column !important;
  gap: 2px !important;
}

.nav-more-btn:hover .nav-more-dropdown {
  display: flex !important;
}

.nav-more-dropdown a {
  color: rgba(255,255,255,0.8) !important;
  font-size: 14px !important;
  padding: 8px 12px !important;
  border-radius: 8px !important;
  white-space: nowrap !important;
  display: block !important;
}

.nav-more-dropdown a:hover {
  background: rgba(255,255,255,0.08) !important;
}

/* Right side of navbar */
.chakra-stack.css-1igwmid {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  flex-shrink: 0 !important;
  flex-direction: row !important;
}

/* Price tickers */
.chakra-stack.css-dten7i {
  display: flex !important;
  align-items: center !important;
  gap: 6px !important;
  flex-direction: row !important;
  background: rgba(255,255,255,0.05) !important;
  border-radius: 20px !important;
  padding: 4px 10px !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  color: #fff !important;
}

/* Connect button */
.chakra-button.css-vpc648 {
  background: transparent !important;
  border: 1px solid rgba(255,255,255,0.3) !important;
  color: #fff !important;
  border-radius: 20px !important;
  padding: 6px 16px !important;
  font-size: 14px !important;
  font-weight: 500 !important;
  cursor: pointer !important;
  white-space: nowrap !important;
}

.chakra-button.css-vpc648:hover {
  background: rgba(255,255,255,0.08) !important;
  border-color: rgba(255,255,255,0.5) !important;
}

/* ===== MAIN CONTENT OFFSET (for fixed header) ===== */
#root > div > div,
#root + div,
body > div:not(#root):first-of-type {
  padding-top: 0 !important;
}

/* Push main content below fixed header */
header.css-yesj0r + * {
  margin-top: 70px !important;
}

main.css-uwwqev {
  margin-top: 70px !important;
}

/* ===== BACKGROUND IMAGE ===== */
body > img[src*="bg-dark"],
.bg-fixed-img {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  object-fit: cover !important;
  z-index: -1 !important;
  opacity: 0.7 !important;
}

/* ===== STRATEGIC PARTNERS - sonic-logo fix ===== */
img[alt*="sonic-logo"],
img[src*="sonic-logo"] {
  filter: brightness(0) invert(1) !important;
}

/* ===== FOOTER ===== */
footer.w-full {
  display: block !important;
  background: #0b0f17 !important;
  border-top: 1px solid rgba(255,255,255,0.07) !important;
}

/* ===== RESPONSIVE ===== */
@media (max-width: 768px) {
  .swapx-nav { display: none !important; }
  header.css-yesj0r { height: 60px !important; }
  main.css-uwwqev { margin-top: 60px !important; }
}
</style>
`;

content = content.replace('</head>', cssfix + '</head>');

// Write the final fixed index.html
fs.writeFileSync('index.html', content);
console.log('✅ index.html fixed!');
console.log('Changes made:');
console.log('  1. React script removed');
console.log('  2. Navbar links injected (Swap, Earn, Voting, xNFT, xNFT Lounge, Cross Chain, More)');
console.log('  3. Comprehensive CSS fixes added (header, logo, nav, disclaimer hide)');
console.log('  4. Header fixed to proper 70px sticky navbar');
