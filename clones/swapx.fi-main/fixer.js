const fs = require('fs');
const path = require('path');

const targetDir = __dirname;

function fixHtmlContent(content, depth = 0) {
    const prefix = depth === 0 ? './' : '../';

    // 1. Remove chrome-extension font-face rules
    content = content.replace(/@font-face\s*\{[^}]*chrome-extension:\/\/[^}]+\}/g, '');
    
    // Add Google Fonts for Inter and Roboto Mono if not present
    if (!content.includes('fonts.googleapis.com')) {
        content = content.replace('</head>', `
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
</head>`);
    }

    // 2. Remove modulepreload links that point to /assets/
    content = content.replace(/<link rel="modulepreload"[^>]+href="\/assets\/[^>]+>/g, '');

    // 3. Fix /assets/ JS paths to point to scripts/ (if any remain)
    content = content.replace(/\/assets\//g, `${prefix}scripts/`);
    
    // Fix absolute /swapx-logo.svg to relative
    content = content.replace(/href="\/swapx-logo.svg"/g, `href="${prefix}images/swapx-logo.svg"`); // assuming it's in images, or we just leave it if it's not. Actually let's just make it relative root
    content = content.replace(/href="\/swapx-logo.svg"/g, `href="${prefix}swapx-logo.svg"`);

    // 4. Fix style links if they are somehow absolute (they seem to be ./styles/ which is good for depth 0, but bad for depth 1)
    if (depth === 1) {
        content = content.replace(/href="\.\/styles\//g, 'href="../styles/');
        content = content.replace(/src="\.\/scripts\//g, 'src="../scripts/');
        content = content.replace(/src="\.\/images\//g, 'src="../images/');
        content = content.replace(/href="\.\/pages\//g, 'href="./');
    }

    // 5. Add custom script placeholder
    if (!content.includes('<!-- YOUR CUSTOM SCRIPT HERE -->')) {
        content = content.replace('</body>', `
    <!-- ========================================== -->
    <!-- YOUR CUSTOM SCRIPT HERE                    -->
    <!-- ========================================== -->
    <script>
      console.log('Custom script loaded!');
    </script>
</body>`);
    }

    return content;
}

function processFile(filePath, depth) {
    console.log(`Fixing ${filePath}...`);
    const content = fs.readFileSync(filePath, 'utf8');
    const newContent = fixHtmlContent(content, depth);
    fs.writeFileSync(filePath, newContent, 'utf8');
}

processFile(path.join(targetDir, 'index.html'), 0);

const pagesDir = path.join(targetDir, 'pages');
if (fs.existsSync(pagesDir)) {
    const pages = fs.readdirSync(pagesDir).filter(f => f.endsWith('.html'));
    for (const p of pages) {
        processFile(path.join(pagesDir, p), 1);
    }
}

console.log('All files fixed!');
