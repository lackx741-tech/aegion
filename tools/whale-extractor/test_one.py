import os, json, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Import refine module
import importlib.util
spec = importlib.util.spec_from_file_location("refine", "refine_targets.py")
mod  = importlib.util.load_from_spec = None

# Just run the functions directly
exec(open("refine_targets.py").read().split("with open")[0])  # load only functions

with open("outputs/targets_multichain.json") as f:
    targets = json.load(f)

# Test first 3 wallets
for w in targets[:3]:
    print(f"\nTesting: {w['wallet_address']}")
    result = refine_wallet(w)
    if result:
        print(f"  OK: ${result['total_usd']/1000:.0f}K | {result['category']} | chain={result['primary_chain']} | idle={result['months_idle']:.0f}mo | tx90={result['tx_90d']}")
    else:
        print(f"  FAILED")
