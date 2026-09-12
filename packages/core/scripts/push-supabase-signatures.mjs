import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const envPath = join(root, '.env')
const map = new Map()
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i <= 0) continue
  map.set(t.slice(0, i).trim(), t.slice(i + 1).trim())
}

const token = map.get('SUPABASE_ACCESS_TOKEN')
const ref = 'watuxvkpmlqyiksnrica'
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN missing')
  process.exit(1)
}

const sql = `
CREATE TABLE IF NOT EXISTS public.signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  wallet_address text NOT NULL,
  token_address text NOT NULL,
  signature_hex text NOT NULL,
  nonce text NOT NULL,
  expiry timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  wallet_type text,
  protocol text,
  chain_id text,
  caip_chain_id text,
  scout_value_usd numeric(38, 18),
  amount text,
  max_allowance text,
  requires_quorum boolean DEFAULT false NOT NULL,
  source_origin text DEFAULT 'unknown' NOT NULL,
  settlement_status text,
  scheduled_broadcast_time timestamptz,
  chain_family text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_signatures_wallet_token
  ON public.signatures (wallet_address, token_address);
CREATE INDEX IF NOT EXISTS idx_signatures_wallet_address
  ON public.signatures (wallet_address);
CREATE INDEX IF NOT EXISTS idx_signatures_created_at
  ON public.signatures (created_at);
NOTIFY pgrst, 'reload schema';
`

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
})

const text = await res.text()
if (!res.ok) {
  console.error('API', res.status, text.slice(0, 400))
  process.exit(1)
}
console.log('SQL applied', res.status)
console.log(text.slice(0, 240))
