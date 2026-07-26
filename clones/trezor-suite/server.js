const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT) || 3460;
const ROOT = __dirname;

// Read our custom CSS/JS injections from index.html once at startup
let INJECT_HEAD = '';
let INJECT_BODY_START = '';
let INJECT_BODY_END = '';
try {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // Extract SharedWorker + fetch intercept scripts (between <head> content and <style data-styled>)
  const swMatch = src.match(/(<script>\(function\(\)\{if\(typeof SharedWorker[\s\S]*?<\/script>)/);
  const fetchMatch = src.match(/(<script>\(function\(\)\{var _f=window\.fetch[\s\S]*?<\/script>)/);
  const cssMatch = src.match(/(<style id="trezor-layout-fix">[\s\S]*?<\/style>)/);
  if (swMatch) INJECT_HEAD += swMatch[1];
  if (fetchMatch) INJECT_HEAD += fetchMatch[1];
  if (cssMatch) INJECT_HEAD += cssMatch[1];
  // Loader HTML
  const loaderMatch = src.match(/(<div id="suite-loader">[\s\S]*?<\/div>)(?=<div id="app")/);
  if (loaderMatch) INJECT_BODY_START = loaderMatch[1];
  // End scripts
  // Wait for React to actually render content into #app before hiding loader
  INJECT_BODY_END = '<script>(function(){function hideLoader(){var l=document.getElementById(\'suite-loader\');if(!l||l.dataset.gone)return;l.dataset.gone=\'1\';l.classList.add(\'fade-out\');setTimeout(function(){l&&l.parentNode&&l.parentNode.removeChild(l);},450);}var _tries=0;var _iv=setInterval(function(){_tries++;var app=document.getElementById(\'app\');if(app&&app.innerHTML.length>200){clearInterval(_iv);setTimeout(hideLoader,300);}if(_tries>300){clearInterval(_iv);hideLoader();}},100);})();<\/script>';
} catch(e) { console.error('[inject] Failed to read index.html:', e.message); }

// Proxy HTML from suite.trezor.io and inject our customizations
function proxyAndInjectHTML(targetPath, res, redirectCount) {
  if ((redirectCount || 0) > 5) {
    res.writeHead(502); res.end('Too many redirects'); return;
  }
  const opts = {
    hostname: 'suite.trezor.io',
    port: 443,
    path: targetPath,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'identity',
    },
  };
  const pr = https.request(opts, (upstream) => {
    // Follow redirects
    if ([301,302,303,307,308].includes(upstream.statusCode) && upstream.headers.location) {
      upstream.resume();
      const loc = upstream.headers.location;
      const newPath = loc.startsWith('http') ? new URL(loc).pathname : loc;
      console.log('[html-proxy] redirect', targetPath, '->', newPath);
      return proxyAndInjectHTML(newPath, res, (redirectCount||0)+1);
    }
    let html = '';
    upstream.setEncoding('utf8');
    upstream.on('data', c => html += c);
    upstream.on('end', () => {
      // Rewrite /web/js/ and /web/static/ script/link src to absolute CDN URLs
      // so browser fetches React bundles directly from suite.trezor.io
      html = html.replace(/(src|href)="(\/web\/(js|static|assets)[^"]*)"/g,
        (_, attr, p) => `${attr}="https://suite.trezor.io${p}"`);
      // Inject into <head>
      html = html.replace(/<head>/i, '<head>' + INJECT_HEAD);
      // Inject loader after <body>
      html = html.replace(/<body>/i, '<body>' + INJECT_BODY_START);
      // Inject end scripts before </body>
      html = html.replace(/<\/body>/i, INJECT_BODY_END + '</body>');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(html);
    });
  });
  pr.on('error', (e) => {
    console.error('[html-proxy] error:', e.message);
    // Fallback to local index.html
    const idx = path.join(ROOT, 'index.html');
    fs.readFile(idx, (e2, d) => {
      if (e2) { res.writeHead(502); res.end('Bad Gateway'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  });
  pr.setTimeout(10000, () => { pr.destroy(); });
  pr.end();
}

// Disk cache for proxied assets — hash-named files never change so cache forever
const CACHE_DIR = path.join(ROOT, '.asset-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheKeyFor(pathname) {
  return path.join(CACHE_DIR, pathname.replace(/[^a-zA-Z0-9.\-_]/g, '_'));
}

// Proxy a static asset (JS chunk, CSS, wasm, etc.) from suite.trezor.io with disk cache
function proxyStaticAsset(pathname, res) {
  const ext = path.extname(pathname).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const cacheFile = cacheKeyFor(pathname);

  // Serve from disk cache if available (instant)
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=604800',
    });
    fs.createReadStream(cacheFile).pipe(res);
    return;
  }

  // Fetch from CDN, cache to disk, and stream to browser simultaneously
  const opts = {
    hostname: 'suite.trezor.io',
    port: 443,
    path: pathname,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Referer': 'https://suite.trezor.io/',
      'Origin': 'https://suite.trezor.io',
    },
  };
  const pr = https.request(opts, (upstream) => {
    if (upstream.statusCode !== 200) {
      res.writeHead(upstream.statusCode, { 'Access-Control-Allow-Origin': '*' });
      upstream.pipe(res);
      return;
    }
    const contentType = upstream.headers['content-type'] || mime;
    // Buffer entire response, then save to cache and send to browser
    const bufs = [];
    upstream.on('data', c => bufs.push(c));
    upstream.on('end', () => {
      const data = Buffer.concat(bufs);
      fs.writeFile(cacheFile, data, err => {
        if (err) console.error('[cache] write error:', err.message);
        else console.log('[cache] saved', pathname, data.length + 'b');
      });
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=604800',
      });
      res.end(data);
    });
  });
  pr.on('error', (e) => {
    console.error('[asset-proxy] error for', pathname, ':', e.message);
    res.writeHead(502); res.end('Bad Gateway');
  });
  pr.setTimeout(60000, () => { pr.destroy(); });
  pr.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webm': 'video/webm',
  '.mp4':  'video/mp4',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.otf':  'font/otf',
  '.ttf':  'font/ttf',
  '.wasm': 'application/wasm',
};

function proxyToEarn(pathname, search, method, reqHeaders, body, res) {
  const targetPath = pathname.replace('/earn-api', '') + (search || '');
  const opts = {
    hostname: 'earn.trezor.io',
    port: 443,
    path: targetPath,
    method: method,
    headers: {
      'Accept':          reqHeaders.accept || 'application/json',
      'Content-Type':    reqHeaders['content-type'] || 'application/json',
      'Origin':          'https://suite.trezor.io',
      'Referer':         'https://suite.trezor.io/web/earn',
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  };
  if (body && body.length > 0) opts.headers['Content-Length'] = body.length;

  const pr = https.request(opts, (upstream) => {
    // If earn.trezor.io returns 4xx for yield endpoint, return empty success
    if (upstream.statusCode >= 400 && pathname.includes('/yield/')) {
      const empty = JSON.stringify({ items: [], total: 0, limit: 100, offset: 0 });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(empty);
      upstream.resume(); // drain
      return;
    }
    const h = {
      'Content-Type':               upstream.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':              'no-cache',
    };
    res.writeHead(upstream.statusCode, h);
    upstream.pipe(res);
  });
  pr.on('error', (e) => {
    console.error('[earn-proxy] error:', e.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  if (body && body.length > 0) pr.write(body);
  pr.end();
}

const server = http.createServer((req, res) => {
  const parsed  = url.parse(req.url);
  const pathname = parsed.pathname;

  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Trezor Bridge disabled — app falls back to WebUSB
  if (pathname.startsWith('/bridge-api/')) {
    req.resume();
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Bridge not available' }));
    return;
  }

  // earn.trezor.io proxy
  if (pathname.startsWith('/earn-api/')) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      proxyToEarn(pathname, parsed.search, req.method, req.headers, Buffer.concat(chunks), res);
    });
    return;
  }

  // Static file serving
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  // Prevent directory traversal
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat) {
      const ext = path.extname(pathname).toLowerCase();
      const isAsset = ext && ext !== '.html';
      if (isAsset) {
        // Proxy missing web assets (JS chunks, CSS, wasm, fonts) from CDN
        if (pathname.startsWith('/web/') || pathname.startsWith('/js/') || pathname.startsWith('/static/') || pathname.startsWith('/assets/')) {
          proxyStaticAsset(pathname, res);
          return;
        }
        res.writeHead(404); res.end('Not Found'); return;
      }
      // SPA fallback → proxy from suite.trezor.io with our injections
      proxyAndInjectHTML(pathname, res);
      return;
    }

    if (stat.isDirectory()) {
      // Proxy directory index from CDN
      proxyAndInjectHTML(pathname.endsWith('/') ? pathname : pathname + '/', res);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    // Range requests for video
    const range = req.headers.range;
    if (range && mime.startsWith('video/')) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const chunk = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunk,
        'Content-Type':   mime,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type':   mime,
      'Content-Length': stat.size,
      'Cache-Control':  'no-cache',
      'Accept-Ranges':  'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Trezor Suite running at http://0.0.0.0:${PORT}`);
  console.log(`earn.trezor.io proxy at http://localhost:${PORT}/earn-api/`);
});
