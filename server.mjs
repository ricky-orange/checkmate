import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getDatabase } from 'firebase-admin/database'
import { GoogleAuth } from 'google-auth-library'
import { newGame, transition } from './game.mjs'

const { GOOGLE_SHEET_ID, FIREBASE_DATABASE_URL, SESSION_SECRET, SECURE_COOKIES, ONLINE_TRANSPORT, PORT = 5173, HOST = '127.0.0.1' } = process.env
if (GOOGLE_SHEET_ID && (!SESSION_SECRET || SESSION_SECRET.length < 32)) throw Error('SESSION_SECRET 須至少 32 字元')
const db = FIREBASE_DATABASE_URL && getDatabase(initializeApp({ credential: applicationDefault(), databaseURL: FIREBASE_DATABASE_URL }))
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] })
const sheet = 'https://sheets.googleapis.com/v4/spreadsheets/' + GOOGLE_SHEET_ID + '/values/Players!A2:F'
const derive = promisify(scrypt)
const lifetime = 86400 * 7
const limits = new Map()
let registration = Promise.resolve()

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function limit(ip) {
  const now = Date.now()
  for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key)
  const entry = limits.get(ip) ?? { count: 0, until: now + 60000 }
  limits.set(ip, entry)
  if (++entry.count > 15) throw failure('請稍後再試', 429)
}

function signature(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url')
}

function same(a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function player(req, slot = 'main') {
  if (!GOOGLE_SHEET_ID) return null
  const token = (req.headers.cookie ?? '').split(/;\s*/).find(value => value.startsWith('cm_' + slot + '='))?.split('=')[1]
  if (!token) return null
  const [data, mac] = token.split('.')
  if (!mac || !same(mac, signature(data))) return null
  const { user, expires } = JSON.parse(Buffer.from(data, 'base64url'))
  return expires > Date.now() ? user : null
}

function cookie(res, slot, user) {
  const data = Buffer.from(JSON.stringify({ user, expires: Date.now() + lifetime * 1000 })).toString('base64url')
  const value = user ? data + '.' + signature(data) : ''
  res.setHeader('Set-Cookie', 'cm_' + slot + '=' + value + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (user ? lifetime : 0) + (SECURE_COOKIES === '1' ? '; Secure' : ''))
}

async function account(body, register) {
  const username = String(body.username ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const name = String(body.name ?? '').trim()
  if (!/^[a-z0-9_.-]{3,32}$/.test(username) || password.length < 8 || password.length > 128 || (register && (!name || name.length > 24))) {
    throw failure('帳號需為 3–32 個英數或 . _ -，密碼至少 8 字元，暱稱最多 24 字元')
  }
  const client = await auth.getClient()
  const { data } = await client.request({ url: sheet })
  const row = (data.values ?? []).find(entry => entry[1] === username)
  if (register) {
    if (row) throw failure('這個帳號已有人使用', 409)
    const id = randomUUID()
    const salt = randomBytes(16).toString('hex')
    const hash = (await derive(password, salt, 64)).toString('hex')
    await client.request({ url: sheet + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', method: 'POST', data: { values: [[id, username, name, salt, hash, new Date().toISOString()]] } })
    return { id, name }
  }
  const hash = (await derive(password, row?.[3] ?? 'invalid-account', 64)).toString('hex')
  if (!row || !same(hash, row[4])) throw failure('帳號或密碼錯誤', 401)
  return { id: row[0], name: row[2] }
}

async function jsonBody(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > 8192) throw failure('請求過大', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks)) } catch { throw failure('請求格式錯誤') }
}

function send(res, value) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function sideOf(game, user) {
  if (game?.players.w.id === user.id) return 'w'
  if (game?.players.b?.id === user.id) return 'b'
  return null
}

async function update(ref, callback) {
  await ref.get()
  let rejected
  const result = await ref.transaction(game => {
    rejected = null
    try { return callback(game) } catch (error) { rejected = error; return game === null ? null : undefined }
  }, undefined, false)
  if (rejected) throw rejected
  return result.snapshot.val()
}

async function api(req, res, path) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET' && path === '/api/session') {
    return send(res, { accounts: Boolean(GOOGLE_SHEET_ID), online: Boolean(db && GOOGLE_SHEET_ID), transport: ONLINE_TRANSPORT === 'poll' ? 'poll' : 'events', main: player(req), second: player(req, 'second') })
  }
  if (req.method === 'POST' && (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '') ||
      (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host))) throw failure('請求來源錯誤', 403)
  if (req.method === 'POST' && /^\/api\/(login|register|logout)$/.test(path)) {
    if (!GOOGLE_SHEET_ID) throw failure('Google Sheets 尚未設定', 503)
    const body = await jsonBody(req)
    const slot = body.slot === 'second' ? 'second' : 'main'
    if (path === '/api/logout') { cookie(res, slot, null); return send(res, {}) }
    limit(req.socket.remoteAddress)
    const register = path === '/api/register'
    const operation = register ? registration.then(() => account(body, true)) : account(body, false)
    if (register) registration = operation.catch(() => {})
    const user = await operation
    cookie(res, slot, user)
    return send(res, user)
  }
  if (!db) throw failure('Firebase 尚未設定', 503)
  const user = player(req)
  if (!user) throw failure('請先登入', 401)
  if (path === '/api/rooms' && req.method === 'POST') {
    const { minutes } = await jsonBody(req)
    const code = randomBytes(8).toString('hex')
    await db.ref('rooms/' + code).set(newGame({ w: user }, minutes))
    return send(res, { code })
  }
  const match = path.match(/^\/api\/rooms\/([a-f0-9]{16})\/(join|events|action|state)$/)
  if (!match) throw failure('找不到頁面', 404)
  const [, code, operation] = match
  const ref = db.ref('rooms/' + code)
  if (operation === 'state' && req.method === 'GET') {
    const game = (await ref.get()).val()
    if (!sideOf(game, user)) throw failure('你未加入此房間', 403)
    return send(res, { game, serverNow: Date.now() })
  }
  if (operation === 'join' && req.method === 'POST') {
    const game = await update(ref, current => {
      if (!current) throw failure('找不到房間', 404)
      if (sideOf(current, user)) return current
      if (current.players.b) throw failure('房間已滿', 409)
      return { ...current, players: { ...current.players, b: user }, started: Date.now(), paused: false, version: current.version + 1 }
    })
    return send(res, game)
  }
  if (operation === 'action' && req.method === 'POST') {
    const action = await jsonBody(req)
    return send(res, await update(ref, game => {
      const side = sideOf(game, user)
      if (!side) throw failure('你未加入此房間', 403)
      if (action.type !== 'tick' && action.version !== game.version) throw failure('棋局已更新，請再試一次', 409)
      try { return transition(game, { ...action, online: true }, side) }
      catch { throw failure('目前無法執行這個動作') }
    }))
  }
  if (operation !== 'events' || req.method !== 'GET') throw failure('找不到頁面', 404)
  if (!sideOf((await ref.get()).val(), user)) throw failure('你未加入此房間', 403)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
  res.write(': connected\n\n')
  const listener = snap => res.write('data: ' + JSON.stringify({ game: snap.val(), serverNow: Date.now() }) + '\n\n')
  ref.on('value', listener, () => res.end())
  const heartbeat = setInterval(() => res.write('event: clock\ndata: ' + Date.now() + '\n\n'), 15000)
  res.on('close', () => { clearInterval(heartbeat); ref.off('value', listener) })
}

const assets = {
  '/': ['public/index.html', 'text/html'],
  '/app.mjs': ['public/app.mjs', 'text/javascript'],
  '/pieces.mjs': ['public/pieces.mjs', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/game.mjs': ['game.mjs', 'text/javascript'],
  '/chess.mjs': ['node_modules/chess.js/dist/esm/chess.js', 'text/javascript'],
}
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) return await api(req, res, path)
    const asset = assets[path]
    if (!asset) throw failure('找不到頁面', 404)
    res.setHeader('Content-Type', asset[1] + '; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(await readFile(new URL(asset[0], import.meta.url)))
  } catch (error) {
    if (res.headersSent) return res.end()
    res.statusCode = error.status ?? 500
    if (!error.status) console.error(error.code ?? error.name)
    send(res, { error: error.status ? error.message : '服務暫時無法使用' })
  }
}).listen(Number(PORT), HOST, () => console.log('Checkmate: http://' + HOST + ':' + PORT))
