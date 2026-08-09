import urllib.request
import os

logos = {
    "ethereum.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
    "bnb.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/binance/info/logo.png",
    "polygon.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/info/logo.png",
    "arbitrum.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/info/logo.png",
    "base.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png",
    "optimism.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/optimism/info/logo.png",
    "avalanche.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/avalanchec/info/logo.png",
    "fantom.png": "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/fantom/info/logo.png"
}

for name, url in logos.items():
    try:
        path = os.path.join("assets", "logos", name)
        print(f"Downloading {name}...")
        urllib.request.urlretrieve(url, path)
        print(f"Downloaded {name}")
    except Exception as e:
        print(f"Failed {name}: {e}")
