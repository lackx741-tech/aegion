/**
 * On-Chain DM Script — Legion Finance
 *
 * Sends a personalized message to each whale wallet via a 0-value transaction.
 * The message is encoded in calldata — visible on Etherscan + most wallets.
 *
 * Chain: Polygon (MATIC) — ~$0.001 per tx = 500 txs for ~$0.50
 *
 * Setup:
 *   1. Copy .env.example → .env and fill SENDER_PRIVATE_KEY + POLYGON_RPC_URL
 *   2. Fund the sender wallet with ~1 MATIC on Polygon
 *   3. Run: node onchain_dm.js [--dry-run] [--limit 10] [--min-usd 1000000]
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────────

// Use individual-filtered list by default (removes institutions/protocols)
// To use all 500: node onchain_dm.js --all
const useAll = process.argv.includes('--all');
const TARGETS_FILE = path.join(__dirname, 'outputs', useAll ? 'targets_500.json' : 'targets_individual.json');
const LOG_FILE     = path.join(__dirname, 'onchain_dm_log.json');

const AUDIT_BASE = 'https://legion-audit-app.surge.sh/?addr=';

// Polygon RPC (public fallback — use your own for reliability)
const DEFAULT_RPC = 'https://polygon-rpc.com';

// Delay between transactions (ms) — be gentle on the RPC
const TX_DELAY_MS = 2000;

// ─── ARGS ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const LIMIT    = (() => { const i = args.indexOf('--limit');   return i >= 0 ? parseInt(args[i+1]) : 500; })();
const MIN_USD  = (() => { const i = args.indexOf('--min-usd'); return i >= 0 ? parseInt(args[i+1]) : 0;   })();

// ─── MESSAGE TEMPLATES ─────────────────────────────────────────────────────────

function buildMessage(target) {
  const addr    = target.wallet_address;
  const usd     = target.total_usd;
  const cat     = target.category;
  const stable  = target.stable_pct || 0;
  const idle    = target.months_idle || 0;
  const link    = AUDIT_BASE + addr;

  const usdStr = usd >= 1e9  ? `$${(usd/1e9).toFixed(1)}B`
               : usd >= 1e6  ? `$${(usd/1e6).toFixed(1)}M`
               : usd >= 1e3  ? `$${(usd/1e3).toFixed(0)}K`
               : `$${Math.round(usd)}`;

  if (cat === 'Stablecoin Hoarder') {
    const idleStr = idle >= 1 ? `${Math.round(idle)}mo` : 'recently';
    return `Your ${usdStr} portfolio (${Math.round(stable)}% stablecoins) has been idle for ${idleStr} earning 0%. Free security audit: ${link}`;
  }

  if (cat === 'Recent Windfall') {
    return `Congrats on the ${usdStr} receive. Free wallet security audit — takes 30s, read-only: ${link}`;
  }

  if (cat === 'Yield Seeker') {
    return `Your ${usdStr} portfolio can be better optimized. Free risk audit: ${link}`;
  }

  if (cat === 'Crypto Salary') {
    return `Your ${usdStr} accumulated portfolio may have hidden risks. Free audit: ${link}`;
  }

  // Default
  return `Free on-chain security audit for your ${usdStr} wallet. Read-only, 30 seconds: ${link}`;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🐋 Legion Finance — On-Chain DM Script');
  console.log('─'.repeat(50));

  // Load targets
  if (!fs.existsSync(TARGETS_FILE)) {
    console.error('ERROR: targets_500.json not found at', TARGETS_FILE);
    process.exit(1);
  }
  let targets = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));

  // Filter
  if (MIN_USD > 0) {
    targets = targets.filter(t => t.total_usd >= MIN_USD);
    console.log(`Filter: min $${MIN_USD.toLocaleString()} → ${targets.length} wallets`);
  }

  // Sort by portfolio size (biggest first)
  targets.sort((a, b) => b.total_usd - a.total_usd);

  // Apply limit
  targets = targets.slice(0, LIMIT);
  console.log(`Targets: ${targets.length} wallets`);

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN — showing messages, no transactions sent\n');
    targets.slice(0, 10).forEach((t, i) => {
      const msg = buildMessage(t);
      const usdStr = t.total_usd >= 1e6
        ? `$${(t.total_usd/1e6).toFixed(1)}M`
        : `$${Math.round(t.total_usd/1000)}K`;
      console.log(`[${i+1}] ${usdStr} | ${t.category}`);
      console.log(`    TO: ${t.wallet_address}`);
      console.log(`    MSG (${msg.length} chars): ${msg}`);
      console.log(`    Calldata: 0x${Buffer.from(msg,'utf8').toString('hex').substring(0,40)}...`);
      console.log('');
    });
    if (targets.length > 10) console.log(`... and ${targets.length - 10} more`);
    console.log('\n✅ Dry run complete. Run without --dry-run to send actual transactions.');
    return;
  }

  // Check env
  const pk  = process.env.SENDER_PRIVATE_KEY;
  const rpc = process.env.POLYGON_RPC_URL || DEFAULT_RPC;

  if (!pk) {
    console.error('\nERROR: SENDER_PRIVATE_KEY not set in .env file');
    console.error('Add it to .env: SENDER_PRIVATE_KEY=0xYourPrivateKeyHere');
    process.exit(1);
  }

  // Connect
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet   = new ethers.Wallet(pk, provider);

  const network  = await provider.getNetwork();
  const balance  = await provider.getBalance(wallet.address);
  const balMATIC = parseFloat(ethers.formatEther(balance)).toFixed(4);

  console.log(`\nNetwork : ${network.name} (chainId: ${network.chainId})`);
  console.log(`Sender  : ${wallet.address}`);
  console.log(`Balance : ${balMATIC} MATIC`);

  if (parseFloat(balMATIC) < 0.05) {
    console.error('\nERROR: Low balance. Fund your wallet with at least 0.1 MATIC on Polygon.');
    process.exit(1);
  }

  // Load or init log
  let log = { sent: [], failed: [], last_run: null };
  if (fs.existsSync(LOG_FILE)) {
    log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  }

  const alreadySent = new Set(log.sent.map(r => r.to.toLowerCase()));

  // Filter already sent
  const pending = targets.filter(t => !alreadySent.has(t.wallet_address.toLowerCase()));
  console.log(`\nAlready sent: ${alreadySent.size} | Pending: ${pending.length}`);

  if (pending.length === 0) {
    console.log('✅ All targets already messaged!');
    return;
  }

  console.log('\nStarting in 3s... Ctrl+C to abort.\n');
  await sleep(3000);

  let sent = 0, failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const t = pending[i];
    const msg = buildMessage(t);
    const data = '0x' + Buffer.from(msg, 'utf8').toString('hex');

    const usdStr = t.total_usd >= 1e6
      ? `$${(t.total_usd/1e6).toFixed(1)}M`
      : `$${Math.round(t.total_usd/1000)}K`;

    process.stdout.write(`[${i+1}/${pending.length}] ${usdStr} ${t.wallet_address.substring(0,10)}... `);

    try {
      const tx = await wallet.sendTransaction({
        to:    t.wallet_address,
        value: 0n,
        data:  data,
      });

      log.sent.push({
        to:       t.wallet_address,
        usd:      t.total_usd,
        category: t.category,
        txHash:   tx.hash,
        msg:      msg,
        ts:       new Date().toISOString(),
      });

      sent++;
      console.log(`✅ tx: ${tx.hash.substring(0,12)}...`);

    } catch (err) {
      log.failed.push({
        to:    t.wallet_address,
        usd:   t.total_usd,
        error: err.message,
        ts:    new Date().toISOString(),
      });
      failed++;
      console.log(`❌ ${err.message.substring(0,60)}`);
    }

    // Save log after each tx
    log.last_run = new Date().toISOString();
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');

    if (i < pending.length - 1) await sleep(TX_DELAY_MS);
  }

  console.log(`\n─────────────────────────────────`);
  console.log(`✅ Sent: ${sent} | ❌ Failed: ${failed}`);
  console.log(`📋 Log saved: ${LOG_FILE}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
