import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'

const output = new URL('./dist/', import.meta.url)
const source = path => new URL(path, import.meta.url)
const copy = (from, to) => copyFile(source(from), new URL(to, output))
await mkdir(output, { recursive: true })

const html = await readFile(source('public/index.html'), 'utf8')
const app = await readFile(source('public/app.mjs'), 'utf8')

await Promise.all([
  writeFile(new URL('index.html', output), html.replace('<html lang="zh-Hant">', '<html lang="zh-Hant" data-guest-only>')
    .replaceAll('.mjs"', '.js"')),
  writeFile(new URL('app.js', output), app.replaceAll(".mjs'", ".js'")),
  copy('public/style.css', 'style.css'),
  copy('public/pieces.mjs', 'pieces.js'),
  copy('game.mjs', 'game.js'),
  copy('node_modules/chess.js/dist/esm/chess.js', 'chess.js'),
  copy('node_modules/chess.js/LICENSE', 'chess.js.LICENSE'),
])
