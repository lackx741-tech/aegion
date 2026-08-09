/**
 * Personalized On-Chain DM Generator — Legion Finance
 *
 * Generates unique, humanized English messages for each whale wallet.
 * Uses smart templates + real on-chain data — no API keys needed.
 * Each message references the wallet's specific weak points.
 *
 * Run: node generate_dm_messages.js [--limit 10] [--min-usd 1000000]
 * Output: outputs/dm_messages.json
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const TARGETS_FILE = path.join(__dirname, 'outputs', 'targets_500.json');
const OUTPUT_FILE  = path.join(__dirname, 'outputs', 'dm_messages.json');
const AUDIT_BASE   = 'https://legion-audit-app.surge.sh/?addr=';

const args    = process.argv.slice(2);
const LIMIT   = (() => { const i = args.indexOf('--limit');   return i >= 0 ? parseInt(args[i+1]) : 9999; })();
const MIN_USD = (() => { const i = args.indexOf('--min-usd'); return i >= 0 ? parseInt(args[i+1]) : 0;    })();

// ─── DETERMINISTIC SHUFFLE (no Math.random — same wallet always same message) ──

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return Math.abs(s) / 0x7fffffff;
  };
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

// ─── FORMAT HELPERS ────────────────────────────────────────────────────────────

function fmtUSD(usd) {
  if (usd >= 1e9)  return `$${(usd/1e9).toFixed(2)}B`;
  if (usd >= 1e6)  return `$${(usd/1e6).toFixed(1)}M`;
  if (usd >= 1e3)  return `$${(usd/1e3).toFixed(0)}K`;
  return `$${Math.round(usd)}`;
}

function fmtIdle(months) {
  if (!months || months < 0.5) return null;
  if (months < 1) return 'weeks';
  if (months === 1) return '1 month';
  return `${Math.round(months)} months`;
}

// ─── WEAK POINT ANALYZER ───────────────────────────────────────────────────────

function analyze(t) {
  const usd    = t.total_usd;
  const stable = t.stable_pct  || 0;
  const idle   = t.months_idle || 0;
  const tx30   = t.tx_30d      || 0;
  const chains = t.chains_active || 1;
  const nfts   = t.nft_count   || 0;
  const age    = t.months_old  || 0;
  const cat    = t.category;

  const stableUSD    = usd * stable / 100;
  const inflationLoss = Math.round(stableUSD * 0.032 / 12 * Math.max(idle, 1));
  const potentialYield = Math.round(stableUSD * 0.05 / 12);

  return {
    usdStr:        fmtUSD(usd),
    stableStr:     fmtUSD(stableUSD),
    stablePct:     Math.round(stable),
    idleStr:       fmtIdle(idle),
    idleMonths:    idle,
    tx30,
    chains,
    nfts,
    age,
    cat,
    inflossStr:    fmtUSD(inflationLoss),
    yieldStr:      fmtUSD(potentialYield),
    isInactive:    tx30 <= 3,
    isStable:      stable >= 55,
    isWindfall:    cat === 'Recent Windfall',
    isYielder:     cat === 'Yield Seeker',
    isSalary:      cat === 'Crypto Salary',
    isIdle:        cat === 'Idle Self-Custody',
    hasNFTs:       nfts >= 10,
    isMultichain:  chains >= 5,
    isOldWallet:   age >= 18 && tx30 <= 5,
    isBig:         usd >= 10_000_000,
  };
}

// ─── MESSAGE TEMPLATES ─────────────────────────────────────────────────────────
// Each template is a function(a, rand) => string
// 'a' = analysis object above
// 'rand' = seeded random function (deterministic per wallet)

const TEMPLATES = {

  // ── STABLECOIN HOARDER (most common) ──────────────────────────────────────
  stablecoin_idle: [
    a => `Ran your wallet. ${a.stablePct}% in stablecoins, idle ${a.idleStr}. At current inflation that's ${a.inflossStr} gone. Your audit: ${AUDIT_BASE}`,
    a => `Your ${a.stableStr} in stable assets has been sitting ${a.idleStr} earning nothing. Inflation already took ${a.inflossStr}. Full breakdown: ${AUDIT_BASE}`,
    a => `${a.stableStr} idle in stables for ${a.idleStr}. No yield, no protection. That's ${a.inflossStr} in real losses already. Worth a look: ${AUDIT_BASE}`,
    a => `Noticed ${a.stablePct}% of your ${a.usdStr} portfolio is stablecoins sitting idle ${a.idleStr}. Could be generating ${a.yieldStr}/mo passively. Audit: ${AUDIT_BASE}`,
    a => `Your wallet shows ${a.stableStr} in stables, zero yield, ${a.idleStr} idle. That's ${a.inflossStr} lost to inflation quietly. Quick scan: ${AUDIT_BASE}`,
    a => `Quick scan on your wallet — ${a.stableStr} in stablecoins has been dormant ${a.idleStr}. Inflation rate is eating ${a.inflossStr} of that silently. See full audit: ${AUDIT_BASE}`,
  ],

  stablecoin_no_idle: [
    a => `${a.stablePct}% of your ${a.usdStr} is in stablecoins earning 0%. Could be ${a.yieldStr}/mo at safe yield rates. Free audit: ${AUDIT_BASE}`,
    a => `Ran a scan on your wallet. ${a.stableStr} in stables, no yield activity detected. That capital's working against you. Audit: ${AUDIT_BASE}`,
    a => `Your portfolio is ${a.stablePct}% stablecoins with zero yield. ${a.usdStr} total. At 5% APY that's ${a.yieldStr}/month left on the table. Full report: ${AUDIT_BASE}`,
    a => `Looked at your wallet — ${a.stableStr} sitting in stables, completely unproductive. No DeFi usage, no yield. Takes 30s to audit: ${AUDIT_BASE}`,
  ],

  // ── RECENT WINDFALL ────────────────────────────────────────────────────────
  windfall: [
    a => `Your wallet received a large transfer recently — fresh wallets holding ${a.usdStr}+ are top phishing targets right now. Free security audit: ${AUDIT_BASE}`,
    a => `Scanned your wallet. ${a.usdStr} received recently. Address poisoning attacks specifically target new large inflows. Worth auditing: ${AUDIT_BASE}`,
    a => `${a.usdStr} is a lot to hold without a security audit. Newly funded wallets get targeted within days. Your free audit: ${AUDIT_BASE}`,
    a => `Ran a check on your wallet. Large recent inflow, no DeFi setup, no yield strategy. Before anything else — run the security audit: ${AUDIT_BASE}`,
    a => `Your ${a.usdStr} wallet is newly funded and already exposed. No hardware confirmation, no yield, multiple risks. Audit first: ${AUDIT_BASE}`,
  ],

  // ── YIELD SEEKER ──────────────────────────────────────────────────────────
  yielder: [
    a => `Your ${a.usdStr} portfolio shows DeFi usage but there are gaps in the strategy. Risk concentration flagged. Full audit: ${AUDIT_BASE}`,
    a => `Ran a scan — ${a.usdStr} in yield positions but some smart contract approvals look stale. Should review: ${AUDIT_BASE}`,
    a => `Your ${a.usdStr} yield setup has some risk vectors that aren't obvious at a glance. Worth a proper audit: ${AUDIT_BASE}`,
    a => `Looked at your DeFi positions — ${a.usdStr} deployed but exposure isn't well balanced across protocols. Audit: ${AUDIT_BASE}`,
  ],

  // ── CRYPTO SALARY ────────────────────────────────────────────────────────
  salary: [
    a => `Your ${a.usdStr} accumulated over ${Math.round(a.age)} months — mostly sitting without a yield or security layer. Audit: ${AUDIT_BASE}`,
    a => `Regular crypto inflows, ${a.usdStr} total — but no yield strategy and several inactive approvals still open. Review: ${AUDIT_BASE}`,
    a => `Ran your wallet. ${a.usdStr} accumulated from regular transfers, no DeFi activity. Capital sitting exposed. Quick audit: ${AUDIT_BASE}`,
  ],

  // ── INACTIVE LARGE WALLET ─────────────────────────────────────────────────
  inactive_large: [
    a => `${a.usdStr} wallet, ${a.tx30} transactions last 30 days. That level of inactivity on a wallet this size raises flags. Audit: ${AUDIT_BASE}`,
    a => `Ran a check — ${a.usdStr} held, barely any activity recently. Large dormant wallets are prime soft targets. Audit: ${AUDIT_BASE}`,
    a => `Your ${a.usdStr} portfolio has been largely quiet. ${a.tx30} txs last month. Dormant wallets accumulate stale approvals. Scan: ${AUDIT_BASE}`,
  ],

  // ── MULTI-CHAIN ───────────────────────────────────────────────────────────
  multichain: [
    a => `Your ${a.usdStr} is spread across ${a.chains} chains — each is a separate attack surface with its own approval set. Audit: ${AUDIT_BASE}`,
    a => `Scanned your wallet — ${a.chains} active chains, ${a.usdStr} total. That's a lot of open approvals to track manually. Full scan: ${AUDIT_BASE}`,
  ],

  // ── NFT HOLDER ────────────────────────────────────────────────────────────
  nft_holder: [
    a => `Your ${a.usdStr} portfolio includes ${a.nfts} NFTs — NFT holders get hit with phishing contracts at a much higher rate. Audit: ${AUDIT_BASE}`,
    a => `Ran a scan. ${a.nfts} NFTs, ${a.usdStr} total. NFT wallets have on average 3x more stale approvals. Worth a check: ${AUDIT_BASE}`,
  ],

  // ── DEFAULT / GENERIC ─────────────────────────────────────────────────────
  default: [
    a => `Scanned your ${a.usdStr} wallet. Found a few things worth flagging — nothing critical yet but worth seeing before it is. Audit: ${AUDIT_BASE}`,
    a => `Ran a quick audit on your wallet. ${a.usdStr} in holdings, some risk vectors flagged. Full breakdown: ${AUDIT_BASE}`,
    a => `Your ${a.usdStr} portfolio has some gaps — idle capital, open approvals, a few things to review. Free audit: ${AUDIT_BASE}`,
    a => `Looked at your wallet. ${a.usdStr} total value, some exposure details flagged. Takes 30s to see the full picture: ${AUDIT_BASE}`,
  ],
};

// ─── TEMPLATE SELECTOR ─────────────────────────────────────────────────────────

function selectTemplate(a, rand) {
  let pool;

  if (a.isWindfall) {
    pool = TEMPLATES.windfall;
  } else if (a.isYielder) {
    pool = TEMPLATES.yielder;
  } else if (a.isSalary) {
    pool = TEMPLATES.salary;
  } else if (a.isStable && a.idleStr) {
    pool = TEMPLATES.stablecoin_idle;
  } else if (a.isStable) {
    pool = TEMPLATES.stablecoin_no_idle;
  } else if (a.isBig && a.isInactive) {
    pool = TEMPLATES.inactive_large;
  } else if (a.isMultichain) {
    pool = TEMPLATES.multichain;
  } else if (a.hasNFTs) {
    pool = TEMPLATES.nft_holder;
  } else {
    pool = TEMPLATES.default;
  }

  return pick(pool, rand);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🐋 Legion Finance — DM Message Generator');
  console.log('─'.repeat(50));

  let targets = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
  targets.sort((a, b) => b.total_usd - a.total_usd);

  if (MIN_USD > 0) {
    targets = targets.filter(t => t.total_usd >= MIN_USD);
    console.log(`Filter: min ${fmtUSD(MIN_USD)} → ${targets.length} wallets`);
  }

  targets = targets.slice(0, LIMIT);
  console.log(`Generating messages for ${targets.length} wallets...\n`);

  const output = {};
  const stats = { stablecoin_idle: 0, stablecoin_no_idle: 0, windfall: 0, yielder: 0, salary: 0, inactive_large: 0, multichain: 0, nft_holder: 0, default: 0 };

  for (let i = 0; i < targets.length; i++) {
    const t    = targets[i];
    const seed = parseInt(t.wallet_address.slice(2, 10), 16); // deterministic seed from wallet
    const rand = seededRand(seed);
    const a    = analyze(t);

    const tmplFn = selectTemplate(a, rand);
    const msg    = (tmplFn(a) + t.wallet_address).substring(0, 280);

    // Pick template type for stats
    let tmplKey = 'default';
    if      (a.isWindfall)             tmplKey = 'windfall';
    else if (a.isYielder)              tmplKey = 'yielder';
    else if (a.isSalary)               tmplKey = 'salary';
    else if (a.isStable && a.idleStr)  tmplKey = 'stablecoin_idle';
    else if (a.isStable)               tmplKey = 'stablecoin_no_idle';
    else if (a.isBig && a.isInactive)  tmplKey = 'inactive_large';
    else if (a.isMultichain)           tmplKey = 'multichain';
    else if (a.hasNFTs)                tmplKey = 'nft_holder';
    stats[tmplKey]++;

    output[t.wallet_address] = {
      rank:        i + 1,
      wallet:      t.wallet_address,
      usd:         t.total_usd,
      usdStr:      a.usdStr,
      category:    t.category,
      template:    tmplKey,
      weak_points: {
        stable_pct:  a.stablePct,
        idle_months: a.idleMonths,
        tx_30d:      a.tx30,
        chains:      a.chains,
        nft_count:   a.nfts,
      },
      message:    msg,
      char_count: msg.length,
      audit_link: AUDIT_BASE + t.wallet_address,
    };

    if (i < 10 || i % 50 === 0) {
      console.log(`[${String(i+1).padStart(3)}] ${a.usdStr.padEnd(10)} ${t.category.padEnd(22)} ${msg.substring(0, 70)}...`);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), { encoding: 'utf8' });

  console.log('\n─'.repeat(50));
  console.log(`✅ Generated: ${targets.length} messages`);
  console.log(`📁 Saved: ${OUTPUT_FILE}`);
  console.log('\nTemplate breakdown:');
  Object.entries(stats).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    console.log(`  ${k.padEnd(22)} ${v}`);
  });

  console.log('\n── SAMPLE MESSAGES ─────────────────────────────');
  const vals = Object.values(output);
  [0, 5, 15, 50, 100].filter(i => i < vals.length).forEach(i => {
    const r = vals[i];
    console.log(`\n[#${r.rank}] ${r.usdStr} | ${r.category}`);
    console.log(`  ${r.message}`);
  });
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
