"""Extract EVM whale addresses from whale_extractor.log"""
import re, json, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))

with open("whale_extractor.log", encoding="utf-8", errors="replace") as f:
    lines = f.readlines()

evm_whales = []
seen = set()
i = 0
while i < len(lines):
    line = lines[i]
    if "2026-07-22" in line:
        m_pos = re.search(r'\[(\d+)/428\] (0x[a-f0-9A-F]+)', line)
        if m_pos:
            addr = m_pos.group(2)
            for j in range(i+1, min(i+12, len(lines))):
                if "2026-07-22" in lines[j] and "ADDED" in lines[j]:
                    m_add = re.search(r'\$([0-9,]+)', lines[j])
                    if m_add and addr not in seen:
                        bal = int(m_add.group(1).replace(",",""))
                        if bal >= 2_000_000:
                            evm_whales.append({"wallet_address": addr, "usd_balance": bal,
                                               "source_chain": "eth"})
                            seen.add(addr)
                    break
    i += 1

evm_whales.sort(key=lambda x: x["usd_balance"], reverse=True)
print(f"EVM whales extracted: {len(evm_whales)}")
for w in evm_whales:
    print(f"  {w['wallet_address']}  ${w['usd_balance']/1e6:.2f}M")

with open("evm_whales_from_log.json", "w") as f:
    json.dump(evm_whales, f, indent=2)
print(f"\nSaved to evm_whales_from_log.json")
