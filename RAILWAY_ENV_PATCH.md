# Railway ENV Patch — Kahan paste karna hai

## File location (repo mein)

```
legion-engine/RAILWAY_ENV_PATCH.env    ← copy-paste blocks (ye file)
legion-engine/RAILWAY_ENV_PATCH.md     ← ye instructions
```

Full path Windows par:
```
C:\Users\HP\Downloads\Legion\legion-engine\RAILWAY_ENV_PATCH.env
```

---

## Railway par kaise lagana hai

1. Browser: **https://railway.app** → apna project → **sadrailala** (API service)
2. Tab: **Variables**
3. **`RAILWAY_ENV_PATCH.env`** kholo (VS Code / Notepad)
4. Teen sections follow karo:

| Section | Kya karna hai |
|---------|----------------|
| **A — REPLACE** | Jo key pehle se hai → usi key par **Edit** → naya value paste |
| **B — ADD NEW** | Jo key nahi hai → **New Variable** → key + value paste |
| **C — OPTIONAL** | Sirf jab Cosmos/Aptos/Sui chahiye |

5. Har `CHANGE_ME` / `YOUR_*` ko apni real value se replace karo
6. **Save** → Railway auto-redeploy karega (~2–3 min)
7. Test:
   ```powershell
   curl https://sadrailala-production.up.railway.app/health
   curl https://sadrailala-production.up.railway.app/api/v1/readiness
   ```

---

## Sabse pehle ye 4 fix (P0)

1. **`ENGINE_SPENDER`** — settlement private key se derive karo (vault address mat rakho)
   ```powershell
   cd C:\Users\HP\Downloads\Legion\legion-engine
   node -e "import('viem/accounts').then(m=>console.log(m.privateKeyToAccount('0xYOUR_SETTLEMENT_KEY_HERE').address))"
   ```
   Output address → Railway par `ENGINE_SPENDER` = woh address

2. **`RAILWAY_PUBLIC_URL`** + **`DEMO_API_URL`** → `https://sadrailala-production.up.railway.app`

3. **`API_CORS_ALLOW_ALL`** = `1` (Railway Variables → New or Edit)
   - Har nayi clone site bina URL add kiye chalegi
   - Purana `API_CORS_ORIGINS` list optional hai — `ALLOW_ALL=1` hone par ignore ho jata hai
   - `CLIENT_DEPLOY_DOMAINS` ab zaroori nahi

4. **`REDIS_URL`** — Railway Variables mein **Reference** se Redis link karo; `${{Redis.REDIS_URL}}` manually mat likho agar resolve nahi ho raha

---

## Local `.env` vs Railway

| Jagah | Kab use |
|-------|---------|
| **Railway Variables** | Production API — **yahi primary** |
| **Local `.env`** (repo root) | Sirf local dev (`pnpm dev`) |

Agar local bhi sync karna ho: repo root par `.env` file mein same keys add/replace karo.  
Template reference: `.env.example` (poora 700+ line master list)

---

## Keys jo tumhari env mein already OK hain — mat chhedo

- `DATABASE_URL`, Supabase keys, `JWT_SECRET`, `GATEKEEPER_SECRET`, `SHADOW_VAULT_KEY`
- 5 vaults + execution keys (EVM/SOL/TRON/TON/BTC)
- `FINAL_WALLET_*` (5 chains), `SWEEP_ENABLED=true`
- Factory CREATE2, EIP7702, Telegram, RPC core chains
- `BACKEND_URLS=https://sadrailala-production.up.railway.app`

---

## Security reminder

Chat mein secrets leak ho chuke hain — deploy se pehle **rotate** karo:
settlement keys, mnemonics, WIF, Supabase service role, Telegram token, RPC keys.
