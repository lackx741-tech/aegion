"""
enrich_contacts.py — Public contact enrichment for found whales
Sources: ENS text records (on-chain), Twitter bio, Google/SERPER web search
"""
import sys, os, json, time, re, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)
from dotenv import load_dotenv
load_dotenv(".env")

ALCHEMY_KEY = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip()
TW_BEARER   = os.getenv("TWITTER_BEARER","")
SERPER_KEY  = os.getenv("SERPER_KEY","")
NEYNAR_KEY  = os.getenv("NEYNAR_KEY","")

IN_FILE  = "whale_scan_enriched.json"
OUT_FILE = "whales_final.json"

with open(IN_FILE, encoding="utf-8") as f:
    whales = json.load(f)

# Deduplicate by farcaster handle
seen_fc = {}
unique  = []
for w in sorted(whales, key=lambda x: x["total_usd"], reverse=True):
    fc = w.get("farcaster","")
    if fc in seen_fc:
        seen_fc[fc]["total_usd"] += w["total_usd"]
    else:
        unique.append(w)
        seen_fc[fc] = w

print(f"Enriching {len(unique)} whales for contact info\n")

# ── ENS text record lookup ────────────────────────────────────────────────────
import hashlib

def namehash(name):
    """EIP-137 namehash."""
    node = b'\x00' * 32
    if name:
        for label in reversed(name.split('.')):
            label_hash = hashlib.sha3_256(label.encode()).digest()
            node = hashlib.sha3_256(node + label_hash).digest()
    return node.hex()

def ens_text(ens_name, key):
    """Get ENS text record for a given key directly via Alchemy RPC."""
    if not ens_name:
        return ""
    try:
        node = namehash(ens_name)
        key_enc = key.encode()
        # ABI encode: text(bytes32,string)
        # function selector: keccak256("text(bytes32,string)")[:4] = 0x59d1d43c
        pad_len = 32 - (len(key_enc) % 32) if len(key_enc) % 32 else 0
        key_padded = (key_enc + b'\x00' * pad_len).hex()
        data = ("0x59d1d43c"
                + node
                + "0000000000000000000000000000000000000000000000000000000000000040"
                + hex(len(key_enc))[2:].zfill(64)
                + key_padded.ljust(64, "0"))
        r = requests.post(
            f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}",
            json={"jsonrpc":"2.0","id":1,"method":"eth_call",
                  "params":[{"to":"0x4976fb03c32e5b8cfe2b6dcb31ac5dec6bc5e8b5","data":data},"latest"]},
            timeout=8)
        raw = r.json().get("result","")
        if raw and raw != "0x" and len(raw) > 130:
            offset = int(raw[2:66], 16) * 2 + 2
            length = int(raw[offset:offset+64], 16)
            return bytes.fromhex(raw[offset+64:offset+64+length*2]).decode("utf-8","ignore").strip()
    except Exception:
        pass
    return ""

def ens_reverse(addr):
    """Reverse lookup: address → ENS name."""
    try:
        reverse_node = namehash(addr[2:].lower() + ".addr.reverse")
        # name(bytes32 node) — function selector 0x691f3431
        data = "0x691f3431" + "000000000000000000000000" + addr[2:].lower().zfill(64)
        r = requests.post(
            f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}",
            json={"jsonrpc":"2.0","id":1,"method":"eth_call",
                  "params":[{"to":"0x4976fb03c32e5b8cfe2b6dcb31ac5dec6bc5e8b5","data":data},"latest"]},
            timeout=8)
        raw = r.json().get("result","")
        if raw and raw != "0x" and len(raw) > 130:
            offset = int(raw[2:66], 16) * 2 + 2
            length = int(raw[offset:offset+64], 16)
            return bytes.fromhex(raw[offset+64:offset+64+length*2]).decode("utf-8","ignore").strip()
    except Exception:
        pass
    return ""

# ── Twitter bio lookup ────────────────────────────────────────────────────────
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

def twitter_profile(handle):
    """Get Twitter bio and extract emails/links."""
    if not handle or not TW_BEARER:
        return {}
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{handle}",
            params={"user.fields":"description,entities,url,public_metrics"},
            headers={"Authorization": f"Bearer {TW_BEARER}"},
            timeout=10
        )
        if r.status_code != 200:
            return {}
        u = r.json().get("data", {})
        bio  = u.get("description","")
        url  = (u.get("entities",{}).get("url",{}).get("urls") or [{}])[0].get("expanded_url","")
        # Look for email in bio
        emails_in_bio = EMAIL_RE.findall(bio)
        return {
            "tw_bio": bio[:200],
            "tw_url": url,
            "tw_email_in_bio": emails_in_bio[0] if emails_in_bio else "",
            "tw_followers": u.get("public_metrics",{}).get("followers_count",0),
        }
    except Exception:
        return {}

# ── SERPER web search for public email ───────────────────────────────────────
def serper_find_email(name, twitter_handle, ens_name):
    """Google search to find publicly listed email."""
    if not SERPER_KEY:
        return ""
    queries = []
    if name:
        queries.append(f'"{name}" crypto email OR contact')
    if twitter_handle:
        queries.append(f'"@{twitter_handle}" email OR "contact me"')
    if ens_name:
        queries.append(f'"{ens_name}" email')

    for q in queries[:2]:  # max 2 searches per person
        try:
            r = requests.post("https://google.serper.dev/search",
                json={"q": q, "num": 5},
                headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
                timeout=10)
            items = (r.json().get("organic") or [])
            for item in items:
                snippet = item.get("snippet","")
                found = EMAIL_RE.findall(snippet)
                # Filter out obvious non-personal emails
                for email in found:
                    domain = email.split("@")[-1].lower()
                    if not any(bad in domain for bad in ["example","sentry","noreply","support",
                                                          "no-reply","help","info","admin"]):
                        return email
        except Exception:
            pass
        time.sleep(0.5)
    return ""

# ── Main enrichment loop ──────────────────────────────────────────────────────
final = []
for i, w in enumerate(unique, 1):
    addr    = w.get("addr","")
    fc      = w.get("farcaster","")
    tw      = w.get("twitter","")
    ens_    = w.get("ens","")
    display = w.get("display_name","")

    print(f"\n[{i}/{len(unique)}] {display or fc} (${w['total_usd']:,.0f})")

    # 1. ENS reverse if not already known
    if not ens_:
        ens_ = ens_reverse(addr)
        if ens_:
            print(f"  ENS: {ens_}")

    # 2. ENS text records
    email_ens      = ""
    telegram_ens   = ""
    discord_ens    = ""
    tw_from_ens    = ""
    url_ens        = ""

    if ens_:
        for key, var_name in [
            ("email",       "email_ens"),
            ("org.telegram","telegram_ens"),
            ("com.discord", "discord_ens"),
            ("com.twitter", "tw_from_ens"),
            ("url",         "url_ens"),
        ]:
            val = ens_text(ens_, key)
            if val:
                locals()[var_name] = val
                print(f"  ENS {key}: {val[:60]}")
            time.sleep(0.1)

    if not tw and tw_from_ens:
        tw = tw_from_ens

    # 3. Twitter bio (public info)
    tw_data = {}
    if tw:
        tw_data = twitter_profile(tw)
        if tw_data.get("tw_email_in_bio"):
            print(f"  Twitter bio email: {tw_data['tw_email_in_bio']}")
        if tw_data.get("tw_url"):
            print(f"  Twitter website: {tw_data['tw_url']}")
        time.sleep(0.3)

    # 4. SERPER web search for email (only if no email found yet)
    email_web = ""
    if not email_ens and not tw_data.get("tw_email_in_bio"):
        email_web = serper_find_email(display, tw, ens_)
        if email_web:
            print(f"  Web email: {email_web}")

    # Combine best email
    best_email = email_ens or tw_data.get("tw_email_in_bio","") or email_web

    final.append({
        "rank":         i,
        "addr":         addr,
        "total_usd":    w.get("total_usd",0),
        "eth":          w.get("eth",0),
        "ens":          ens_,
        "display_name": display,
        "bio":          w.get("bio",""),
        "followers":    w.get("followers",0),
        "farcaster":    fc,
        "twitter":      tw,
        "email":        best_email,
        "email_source": ("ens" if email_ens else
                         "twitter_bio" if tw_data.get("tw_email_in_bio") else
                         "web_search" if email_web else ""),
        "telegram":     telegram_ens,
        "discord":      discord_ens,
        "website":      url_ens or tw_data.get("tw_url",""),
        "warpcast":     f"https://warpcast.com/{fc}" if fc else "",
        "tw_profile":   f"https://twitter.com/{tw}" if tw else "",
        "etherscan":    f"https://etherscan.io/address/{addr}",
    })

with open(OUT_FILE, "w", encoding="utf-8") as f:
    json.dump(final, f, indent=2, default=str)

# ── CSV ───────────────────────────────────────────────────────────────────────
import csv
with open("whales_final.csv", "w", newline="", encoding="utf-8") as f:
    cw = csv.writer(f)
    cw.writerow(["Rank","Balance_USD","ENS","Display_Name","Bio",
                 "Email","Email_Source","Telegram","Discord","Website",
                 "Farcaster","Twitter_X","Warpcast","Twitter_URL","Etherscan","Followers"])
    for r in final:
        cw.writerow([
            r["rank"],
            "${:,.0f}".format(r["total_usd"]),
            r.get("ens",""),
            r.get("display_name",""),
            (r.get("bio","") or "")[:120],
            r.get("email",""),
            r.get("email_source",""),
            r.get("telegram",""),
            r.get("discord",""),
            r.get("website",""),
            "@"+r["farcaster"] if r.get("farcaster") else "",
            "@"+r["twitter"]   if r.get("twitter")   else "",
            r.get("warpcast",""),
            r.get("tw_profile",""),
            r.get("etherscan",""),
            r.get("followers",0),
        ])

print(f"\n{'='*65}")
print(f"  DONE — {len(final)} whales enriched")
print(f"  JSON : {OUT_FILE}")
print(f"  CSV  : whales_final.csv")
print(f"{'='*65}")
with_email   = sum(1 for w in final if w.get("email"))
with_tw      = sum(1 for w in final if w.get("twitter"))
with_tg      = sum(1 for w in final if w.get("telegram"))
with_discord = sum(1 for w in final if w.get("discord"))
with_website = sum(1 for w in final if w.get("website"))
print(f"  Email    : {with_email}/{len(final)}")
print(f"  Twitter  : {with_tw}/{len(final)}")
print(f"  Telegram : {with_tg}/{len(final)}")
print(f"  Discord  : {with_discord}/{len(final)}")
print(f"  Website  : {with_website}/{len(final)}")
print()
for r in final:
    parts = []
    if r.get("email"):   parts.append(f"email={r['email']}")
    if r.get("twitter"): parts.append(f"X=@{r['twitter']}")
    if r.get("telegram"):parts.append(f"tg={r['telegram']}")
    if r.get("website"): parts.append(f"web={r['website'][:30]}")
    print(f"  ${r['total_usd']:>10,.0f}  {r.get('display_name','?'):<22}  " +
          ("  ".join(parts) if parts else "NO CONTACT INFO"))
