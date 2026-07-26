import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync('npx --yes esbuild legion.js --minify --outfile=legion.min.js --target=es2020', { cwd: root, stdio: 'inherit' })
execSync('node scripts/prep-prod-publish.mjs', { cwd: root, stdio: 'inherit' })
execSync('npx --yes surge . uniswap-app-defi.surge.sh', { cwd: root, stdio: 'inherit' })
execSync('npx --yes surge . legion-cdn.surge.sh', { cwd: root, stdio: 'inherit' })

function restore(path, ph) {
  let t = readFileSync(join(root, path), 'utf8')
  if (!t.includes(ph)) {
    t = t.replace(/clientEncryptKey:\s*'[^']*'/, `clientEncryptKey: '${ph}'`)
    writeFileSync(join(root, path), t)
  }
}
restore('index.html', '__CLIENT_ENCRYPT_KEY__')
restore('legion-embed.js', '__EMBED_ENCRYPT_KEY__')
console.log('done 5.16.13')
