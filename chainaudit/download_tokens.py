import urllib.request
import os

tokens = ['ETH','WETH','BTC','USDC','USDT','BNB','DAI','WBTC','MATIC','LINK','UNI','ARB','OP','AAVE','CRV','MKR','LDO','SNX']

special_urls = {
    'steth': 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84/logo.png',
    'wsteth': 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0/logo.png',
    'reth': 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xae78736Cd615f374D3085123A210448E74Fc6393/logo.png',
    'cbeth': 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xBe9895146f7AF43049ca1c1AE358B0541Ea49704/logo.png',
    'pol': 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x455e53C3B4E8C228E1ef8EC6609915904D81Fe48/logo.png'
}

for sym in tokens:
    url = f"https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/{sym.lower()}.png"
    path = os.path.join("assets", "logos", f"{sym.lower()}.png")
    try:
        urllib.request.urlretrieve(url, path)
        print(f"Downloaded {sym}")
    except Exception as e:
        print(f"Failed {sym}: {e} from {url}")
        
for sym, url in special_urls.items():
    path = os.path.join("assets", "logos", f"{sym.lower()}.png")
    try:
        urllib.request.urlretrieve(url, path)
        print(f"Downloaded {sym}")
    except Exception as e:
        print(f"Failed {sym}: {e} from {url}")
