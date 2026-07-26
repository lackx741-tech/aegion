const fs = require('fs');
const path = require('path');

const targetDir = __dirname;

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace absolute /assets/ with ./scripts/ (for JS) or ./styles/ (for CSS)
  // Wait, let's just see how many times /assets/ appears
  const assetsMatches = [...content.matchAll(/\/assets\/([^\"']+)/g)].map(m => m[0]);
  const chromeExtMatches = [...content.matchAll(/chrome-extension:\/\/[^\/]+\/assets\/([^\"']+)/g)].map(m => m[1]);
  
  if (assetsMatches.length > 0 || chromeExtMatches.length > 0) {
      console.log('File:', filePath);
      console.log('Assets:', new Set(assetsMatches));
      console.log('ChromeExt:', new Set(chromeExtMatches));
  }
}

fixFile(path.join(targetDir, 'index.html'));
const pages = fs.readdirSync(path.join(targetDir, 'pages')).filter(f => f.endsWith('.html'));
for (const p of pages) {
  fixFile(path.join(targetDir, 'pages', p));
}
