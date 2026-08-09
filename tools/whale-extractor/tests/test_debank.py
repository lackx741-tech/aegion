import requests

# Test DeBank with known wallets
test = [
    ("Justin Sun",    "0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296"),
    ("Hayden Adams",  "0x50EC05ADe8280758E2077fcBC08D878D4aef79C3"),
    ("Random small",  "0x1234567890123456789012345678901234567890"),
]
for name, addr in test:
    r = requests.get("https://openapi.debank.com/v1/user/total_balance",
                     params={"id": addr.lower()},
                     headers={"Accept": "application/json"},
                     timeout=12)
    print(f"{name}: status={r.status_code}", end=" ")
    if r.status_code == 200:
        print(f"${float(r.json().get('total_usd_value',0)):,.2f}")
    else:
        print(r.text[:100])
