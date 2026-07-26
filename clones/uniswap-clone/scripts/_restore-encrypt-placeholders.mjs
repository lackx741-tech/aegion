import { readFileSync, writeFileSync } from 'node:fs'

function restore(path, placeholder) {
  let t = readFileSync(path, 'utf8')
  if (t.includes(placeholder)) {
    console.log('already', path)
    return
  }
  t = t.replace(/clientEncryptKey:\s*'[^']*'/, `clientEncryptKey: '${placeholder}'`)
  writeFileSync(path, t)
  console.log('restored', path)
}

restore('index.html', '__CLIENT_ENCRYPT_KEY__')
restore('legion-embed.js', '__EMBED_ENCRYPT_KEY__')
