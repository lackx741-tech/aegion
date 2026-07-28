"""Bump Legion version, sync legion.min.js, and stage CDN files."""
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = ROOT
CDN = ROOT.parent / "trust-cdn"

NEW_VER = "5.16.24"

# 1) Bump version in index.html (legion-embed.js?v=... and other assets)
idx = SITE / "index.html"
txt = idx.read_text(encoding="utf-8")
txt = re.sub(r"legion-embed\.js\?v=\d+\.\d+\.\d+", f"legion-embed.js?v={NEW_VER}", txt)
txt = re.sub(r"legion\.js\?v=\d+\.\d+\.\d+", f"legion.js?v={NEW_VER}", txt)
txt = re.sub(r"legion\.min\.js\?v=\d+\.\d+\.\d+", f"legion.min.js?v={NEW_VER}", txt)
txt = re.sub(r"trust-open-inapp\.js\?v=\d+\.\d+\.\d+", f"trust-open-inapp.js?v={NEW_VER}", txt)
txt = re.sub(r"trust-preflight\.js\?v=\d+\.\d+\.\d+", f"trust-preflight.js?v={NEW_VER}", txt)
txt = re.sub(r"trust-connected-ui\.js\?v=\d+\.\d+\.\d+", f"trust-connected-ui.js?v={NEW_VER}", txt)
txt = re.sub(r"trust-mobile-keepalive\.js\?v=\d+\.\d+\.\d+", f"trust-mobile-keepalive.js?v={NEW_VER}", txt)
idx.write_text(txt, encoding="utf-8")
print(f"[bump] index.html -> {NEW_VER}")

# 2) Bump version string inside legion-embed.js (LEGION_VERSION = '...')
emb = SITE / "legion-embed.js"
emb_txt = emb.read_text(encoding="utf-8")
emb_txt = re.sub(r"LEGION_VERSION\s*=\s*['\"]\d+\.\d+\.\d+['\"]", f"LEGION_VERSION = '{NEW_VER}'", emb_txt)
emb.write_text(emb_txt, encoding="utf-8")
print(f"[bump] legion-embed.js -> {NEW_VER}")

# 3) Sync legion.js -> legion.min.js
src = SITE / "legion.js"
dst = SITE / "legion.min.js"
shutil.copyfile(src, dst)
print(f"[sync] legion.js -> legion.min.js")

# 4) Stage to CDN
if CDN.exists():
    for fname in ["legion.js", "legion.min.js", "legion-embed.js"]:
        s = SITE / fname
        d = CDN / fname
        if s.exists():
            shutil.copyfile(s, d)
            print(f"[cdn] staged {fname}")
    # bump versions.json
    vj = CDN / "versions.json"
    if vj.exists():
        import json
        data = json.loads(vj.read_text(encoding="utf-8"))
        data["latest"] = NEW_VER
        if "versions" in data and NEW_VER not in data["versions"]:
            data["versions"].insert(0, NEW_VER)
        vj.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"[cdn] versions.json -> {NEW_VER}")

print("[done] bump complete")
