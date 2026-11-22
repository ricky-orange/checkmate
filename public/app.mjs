import { pieceImage } from './pieces.mjs'
import { newGame, position, remaining, transition } from './game.mjs'

const $ = id => document.getElementById(id)
const saved = key => {
  try { return JSON.parse(localStorage.getItem(key)) } catch { return null }
}
const persist = (key, value) => localStorage.setItem(key, JSON.stringify(value))
const guest = { w: { id: 'white', name: '白方' }, b: { id: 'black', name: '黑方' } }
const names = { k: '王', q: '后', r: '車', b: '象', n: '馬', p: '兵' }
const guestOnly = document.documentElement.hasAttribute('data-guest-only')
const requestedRoom = guestOnly ? null : new URLSearchParams(location.search).get('room')
let session = {}
let local = loadLocalGame('local')
let online = null
let room = null
let mode = null
let unlocked = guestOnly
let computer = loadLocalGame('computer')
const modeNames = { computer: '電腦對戰', online: '線上對戰', local: '兩人同玩' }
let selected = ''
let stream
let offset = 0
let connected = false
let busy = false
let slot = 'main'
let registering = false
let renderedGame = null
let moveAnimations = []
const difficultyNames = { easy: '入門', normal: '標準', hard: '進階' }
const computerDelays = { easy: 2000, normal: 3000, hard: 4000 }
const game = () => mode === 'local' ? local : mode === 'computer' ? computer : mode === 'online' ? online : null
const side = () => game()?.players.w.id === session.main?.id ? 'w' : 'b'
const message = text => { $('message').textContent = text }
const active = g => g && g.players.b && !g.result
$('room-code').value = requestedRoom ?? ''
$('hints').checked = saved('checkmate.hints') !== false

function loadLocalGame(kind) {
  const game = saved('checkmate.' + kind)
  if (!game?.players?.w || !game.players.b) return null
  if (game.mode && game.mode !== kind) return null
  const hasComputer = game.players.b.id === 'computer'
  return hasComputer === (kind === 'computer') ? game : null
}

function onlineSaveKey() {
  return 'checkmate.room.' + session.main?.id
}

async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw Error(data.error)
  return data
}

async function attempt(callback) {
  message('')
  try { await callback() } catch (error) { message(error.message) }
}

function setLocal(value) {
  local = { ...value, mode: 'local' }
  persist('checkmate.local', local)
}

function localAccess(g) {
  return !session.accounts || (g.players.w.id === session.main?.id && g.players.b.id === session.second?.id)
}

function renderClocks() {
  const g = game()
  if (!g) return
  for (const color of ['w', 'b']) {
    const clock = $('clock-' + color)
    if (!clock) continue
    const seconds = Math.ceil(remaining(g, color, Date.now() + (mode === 'online' ? offset : 0)) / 1000)
    clock.textContent = g.minutes ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : '不限時'
  }
}

function render() {
  const entered = Boolean(session.main || unlocked)
  $('entry').hidden = entered
  $('mode-picker').hidden = !entered || Boolean(mode)
  $('game-screen').hidden = !entered || !mode
  $('account').hidden = guestOnly || !entered
  $('back-modes').hidden = !entered || !mode
  $('entry-guest').hidden = session.accounts !== false
  $('entry-login').disabled = session.accounts !== true
  $('entry-register').disabled = session.accounts !== true
  $('entry-message').textContent = session.accounts === false ? '帳號服務尚未連接，可先用訪客模式試玩。' : ''
  $('account').textContent = session.main ? '登出 · ' + session.main.name : '離開訪客模式'
  if (!entered || !mode) return
  $('mode-title').textContent = modeNames[mode]
  const g = game()
  const chess = position(g ?? {})
  const orientation = mode === 'online' && g ? side() : 'w'
  const colors = orientation === 'w' ? ['b', 'w'] : ['w', 'b']
  const allowed = active(g) && !g.paused && (mode === 'local' ? localAccess(g) : mode === 'computer' ? g.turn === 'w' : connected && side() === g.turn)
  for (const [index, color] of colors.entries()) {
    const panel = $(index ? 'white' : 'black')
    panel.classList.toggle('active', Boolean(active(g) && g.turn === color && !g.paused))
    panel.classList.toggle('facing', mode === 'local' && !index)
    const label = document.createElement('span')
    label.textContent = (g?.players[color]?.name ?? (color === 'w' ? '白方' : g ? '等待對手' : '黑方')) + (active(g) && g.turn === color ? ' · 輪到走棋' : '')
    const clock = document.createElement('span')
    clock.className = 'clock'
    clock.id = 'clock-' + color
    panel.replaceChildren(label, clock)
  }
  const board = $('board')
  board.classList.toggle('facing-piece', mode === 'local')
  let legal = []
  if (allowed && selected) legal = chess.moves({ square: selected, verbose: true })
  const cells = chess.board().flatMap((row, rank) => row.map((piece, file) => ({ piece, rank, file })))
  if (orientation === 'b') cells.reverse()
  const moves = g?.moves ?? []
  const last = moves.at(-1)
  const previous = renderedGame
  const canAnimate = previous?.mode === mode && previous.orientation === orientation &&
    moves.length === previous.moveCount + 1 &&
    JSON.stringify(moves.at(-2)) === JSON.stringify(previous.lastMove)
  renderedGame = { mode, orientation, moveCount: moves.length, lastMove: last }
  for (const animation of moveAnimations) animation.cancel()
  moveAnimations = []
  const focusSquare = document.activeElement?.dataset.square
  board.replaceChildren(...cells.map(({ piece, rank, file }, index) => {
    const square = 'abcdefgh'[file] + (8 - rank)
    const cell = document.createElement('button')
    cell.dataset.square = square
    cell.className = 'square ' + ((rank + file) % 2 ? 'dark' : 'light')
    cell.setAttribute('aria-label', square + (piece ? ' ' + (piece.color === 'w' ? '白' : '黑') + names[piece.type] : ''))
    if (last?.from === square || last?.to === square) cell.classList.add('last')
    if (selected === square) cell.classList.add('selected')
    const hint = legal.find(move => move.to === square)
    if ($('hints').checked && hint) cell.classList.add(hint.captured ? 'capture' : 'legal')
    if (piece) cell.append(pieceImage(piece.type, piece.color))
    if (index % 8 === 0 || index >= 56) {
      const coord = document.createElement('span')
      coord.className = 'coord'
      coord.textContent = index === 56 ? square : index >= 56 ? square[0] : square[1]
      cell.append(coord)
    }
    return cell
  }))
  if (canAnimate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const move = chess.history({ verbose: true }).at(-1)
    animateMove(move.from, move.to, move.promotion && move.color)
    if (move.isKingsideCastle()) animateMove('h' + move.to[1], 'f' + move.to[1])
    if (move.isQueensideCastle()) animateMove('a' + move.to[1], 'd' + move.to[1])
  }
  if (focusSquare) board.querySelector('[data-square="' + focusSquare + '"]')?.focus({ preventScroll: true })
  const records = chess.history({ verbose: true })
  const log = $('moves')
  const scroller = $('move-scroll')
  const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8
  log.replaceChildren(...Array.from({ length: Math.ceil(records.length / 2) }, (_, index) => {
    const row = document.createElement('tr')
    const round = document.createElement('th')
    round.scope = 'row'
    round.textContent = index + 1
    row.append(round)
    for (const move of [records[index * 2], records[index * 2 + 1]]) {
      const cell = row.insertCell()
      if (!move) {
        cell.textContent = '—'
        continue
      }
      const route = document.createElement('span')
      route.className = 'move-route'
      route.textContent = move.from + ' → ' + move.to
      const notation = document.createElement('small')
      notation.className = 'move-notation'
      notation.textContent = move.san
      cell.append(route, notation)
    }
    return row
  }))
  if (follow) scroller.scrollTop = scroller.scrollHeight
  $('setup').hidden = Boolean(g && !g.result) || (mode === 'online' && !session.online)
  $('join').hidden = mode !== 'online' || !session.online || Boolean(g && !g.result)
  $('resume-online').hidden = mode !== 'online' || !session.online || !session.main ||
    Boolean(g && !g.result) || !saved(onlineSaveKey())
  $('second-area').hidden = mode !== 'local' || !session.accounts
  $('difficulty-area').hidden = mode !== 'computer'
  $('second').textContent = session.second ? '第二位玩家 · ' + session.second.name : '第二位玩家登入'
  $('start').textContent = mode === 'online' ? '建立房間' : '開始對局'
  $('room').hidden = mode !== 'online' || !room
  $('controls').hidden = !g || !g.players.b
  $('pause').hidden = Boolean(g?.result)
  $('resign').hidden = Boolean(g?.result)
  $('pause').disabled = !g || (mode !== 'online' ? mode === 'local' && !localAccess(g) : !connected || g.pauseBy === side())
  $('resign').disabled = !g || (mode !== 'online' ? mode === 'local' && !localAccess(g) : !connected)
  $('pause').textContent = g?.paused ? '繼續這局' : g?.pauseBy ? (g.pauseBy === side() ? '等待對方同意' : '同意暫停') : '暫停'
  $('export').disabled = !moves.length
  $('status').textContent = g?.result ? (g.result === 'draw' ? '和棋' : (g.result === 'w' ? '白方' : '黑方') + '獲勝 · ' + g.reason)
    : mode === 'online' && !session.online ? '線上服務尚未設定'
    : g && !g.players.b ? '等待對手加入'
    : g && mode === 'online' && !connected ? '正在連線…'
    : g && mode === 'local' && !localAccess(g) ? '請用原對局的兩個帳號登入'
    : g?.paused ? '對局已暫停'
    : mode === 'computer' && g?.turn === 'b' ? '電腦思考中…'
    : g && chess.isCheck() ? '將軍'
    : g ? '對局進行中'
    : mode === 'local' && !session.accounts ? '本機訪客試玩'
    : mode === 'online' ? '建立房間或加入好友的棋局' : mode === 'computer' ? '你執白，電腦執黑' : '兩位玩家登入後開始'
  renderClocks()
}

function animateMove(from, to, promotionColor) {
  const origin = $('board').querySelector('[data-square="' + from + '"]')
  const destination = $('board').querySelector('[data-square="' + to + '"]')
  const piece = destination?.querySelector('.piece')
  if (!origin || !piece) return
  const start = origin.getBoundingClientRect()
  const end = destination.getBoundingClientRect()
  const traveler = promotionColor ? pieceImage('p', promotionColor) : piece
  if (promotionColor) {
    traveler.classList.add('promotion-traveler')
    destination.append(traveler)
    piece.style.visibility = 'hidden'
  }
  destination.classList.add('moving-square')
  const animation = traveler.animate([
    { translate: (start.x - end.x) + 'px ' + (start.y - end.y) + 'px' },
    { translate: '0px 0px' },
  ], { duration: 220, easing: 'cubic-bezier(.22,.65,.36,1)' })
  moveAnimations.push(animation)
  animation.onfinish = () => {
    destination.classList.remove('moving-square')
    if (promotionColor) { traveler.remove(); piece.style.visibility = '' }
  }
}

async function act(action) {
  if (busy) return
  busy = true
  try {
    const g = game()
    if (mode === 'computer') {
      saveComputer(transition(g, action, action.type === 'resign' ? 'w' : g.turn))
      render()
      scheduleComputer()
      return
    }
    if (mode === 'local') {
      if (!localAccess(g)) throw Error('請用原對局的兩個帳號登入')
      setLocal(transition(g, action, g.turn))
      render()
      return
    }
    const code = room
    const next = await api('rooms/' + code + '/action', { ...action, version: g.version })
    if (room === code && next.version > online.version) { online = next; render() }
  } finally { busy = false }
}

$('board').addEventListener('click', event => attempt(async () => {
  const square = event.target.closest('[data-square]')?.dataset.square
  const g = game()
  if (!square || !active(g) || g.paused || busy || moveAnimations.some(animation => animation.playState === 'running') ||
      (mode === 'local' ? !localAccess(g) : mode === 'computer' ? g.turn !== 'w' : !connected || g.turn !== side())) return
  const chess = position(g)
  const candidates = selected ? chess.moves({ square: selected, verbose: true }).filter(move => move.to === square) : []
  if (candidates.length) {
    const from = selected
    let promotion
    if (candidates[0].promotion) {
      const dialog = $('promotion')
      for (const button of dialog.querySelectorAll('button[value]:not([value=""])')) {
        button.classList.add('promotion-piece')
        const label = document.createElement('span')
        label.textContent = names[button.value]
        button.replaceChildren(pieceImage(button.value, g.turn), label)
      }
      dialog.returnValue = ''
      dialog.showModal()
      await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }))
      promotion = dialog.returnValue
      if (!promotion || game() !== g) return
    }
    selected = ''
    await act({ type: 'move', from, to: square, promotion })
  } else {
    selected = selected !== square && chess.get(square)?.color === g.turn ? square : ''
    render()
  }
}))

function openAuth(nextSlot, create = false) {
  if (!session.accounts) return message('Google Sheets 尚未設定，目前可使用本機訪客試玩。')
  slot = nextSlot
  registering = create
  $('auth-form').reset()
  $('auth-error').textContent = ''
  authLabels()
  $('auth-dialog').showModal()
}

function authLabels() {
  $('auth-title').textContent = (slot === 'second' ? '第二位玩家' : '玩家') + (registering ? '註冊' : '登入')
  $('nickname').hidden = !registering
  $('nickname').querySelector('input').required = registering
  $('auth-submit').textContent = registering ? '註冊並登入' : '登入'
  $('auth-toggle').textContent = registering ? '返回登入' : '註冊'
  $('auth-form').elements.password.autocomplete = registering ? 'new-password' : 'current-password'
}

$('entry-login').onclick = () => openAuth('main')
$('entry-register').onclick = () => openAuth('main', true)
$('entry-guest').onclick = () => { unlocked = true; render() }
$('account').onclick = () => attempt(async () => {
  if (session.main) await api('logout', { slot: 'main' })
  if (session.second) await api('logout', { slot: 'second' })
  session.main = null
  session.second = null
  unlocked = false
  stream?.close()
  online = null
  room = null
  connected = false
  chooseMode(null)
})
$('second').onclick = () => openAuth('second')
$('auth-close').onclick = () => $('auth-dialog').close()
$('auth-toggle').onclick = () => { registering = !registering; authLabels() }
$('auth-form').onsubmit = async event => {
  event.preventDefault()
  $('auth-submit').disabled = true
  $('auth-error').textContent = ''
  try {
    const before = session[slot]?.id
    session[slot] = await api(registering ? 'register' : 'login', { ...Object.fromEntries(new FormData(event.target)), slot })
    if (slot === 'main' && before !== session.main.id) {
      if (online) { stream?.close(); online = null; room = null; connected = false }
    }
    $('auth-dialog').close()
    render()
    if (slot === 'main' && requestedRoom && !online && session.online) { chooseMode('online'); await attempt(() => connect(requestedRoom)) }
  } catch (error) { $('auth-error').textContent = error.message }
  finally { $('auth-submit').disabled = false }
}

async function connect(code) {
  code = code.trim().toLowerCase()
  if (!/^[a-f0-9]{16}$/.test(code)) throw Error('請輸入有效房間碼')
  if (!session.main) { openAuth('main'); return }
  const participant = session.main.id
  const joined = await api('rooms/' + code + '/join', {})
  if (session.main?.id !== participant) return
  stream?.close()
  room = code
  persist(onlineSaveKey(), code)
  $('room-code').value = code
  $('invite').value = new URL('/?room=' + code, location.href).href
  online = joined
  connected = false
  const connection = new EventSource('/api/rooms/' + code + '/events')
  stream = connection
  connection.onmessage = event => {
    if (stream !== connection) return
    const { game: value, serverNow } = JSON.parse(event.data)
    offset = serverNow - Date.now()
    const shouldRender = !connected || value.version > online.version
    connected = true
    if (value.version >= online.version) {
      if (value.version !== online.version) selected = ''
      online = value
    }
    if (shouldRender) render()
  }
  connection.addEventListener('clock', event => { offset = Number(event.data) - Date.now() })
  connection.onerror = () => { if (stream === connection) { connected = false; render() } }
  render()
}

$('setup').onsubmit = event => {
  event.preventDefault()
  return attempt(async () => {
    if (busy) return
    const minutes = $('unlimited').checked ? 0 : Number($('minutes').value)
    if (mode === 'online') {
      if (!session.main) return openAuth('main')
      busy = true
      try {
        const { code } = await api('rooms', { minutes })
        await connect(code)
      } finally { busy = false }
      return
    }
    if (mode === 'computer') {
      const difficulty = new FormData(event.currentTarget).get('difficulty') ?? 'normal'
      persist('checkmate.difficulty', difficulty)
      saveComputer({
        ...newGame({ w: session.main ?? guest.w, b: { id: 'computer', name: '電腦 · ' + difficultyNames[difficulty] } }, minutes),
        difficulty,
      })
      selected = ''
      render()
      return
    }
    if (session.accounts && !session.main) return openAuth('main')
    if (session.accounts && !session.second) return openAuth('second')
    if (session.accounts && session.main.id === session.second.id) throw Error('兩位玩家需要使用不同帳號')
    setLocal(newGame(session.accounts ? { w: session.main, b: session.second } : guest, minutes))
    selected = ''
    render()
  })
}
$('join').onsubmit = event => { event.preventDefault(); return attempt(() => connect($('room-code').value)) }
$('resume-online').onclick = () => attempt(() => connect(saved(onlineSaveKey())))
$('copy').onclick = () => attempt(async () => {
  $('invite').select()
  if (navigator.clipboard) { await navigator.clipboard.writeText($('invite').value); message('已複製邀請連結') }
})
$('unlimited').onchange = () => { $('minutes').disabled = $('unlimited').checked }
$('hints').onchange = () => { persist('checkmate.hints', $('hints').checked); render() }
$('pause').onclick = () => attempt(() => act({ type: game().paused ? 'resume' : 'pause' }))
$('resign').onclick = () => attempt(async () => {
  const color = mode === 'online' ? side() : mode === 'computer' ? 'w' : game().turn
  if (confirm((color === 'w' ? '白方' : '黑方') + '確定認輸？')) await act({ type: 'resign' })
})
$('export').onclick = () => {
  const g = game()
  const chess = position(g)
  chess.setHeader('White', g.players.w.name.replace(/["\\\r\n]/g, ' '))
  chess.setHeader('Black', g.players.b.name.replace(/["\\\r\n]/g, ' '))
  chess.setHeader('Result', ({ w: '1-0', b: '0-1', draw: '1/2-1/2' })[g.result] ?? '*')
  const url = URL.createObjectURL(new Blob([chess.pgn()], { type: 'application/x-chess-pgn' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'checkmate.pgn' })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }

function saveComputer(value) {
  computer = { ...value, mode: 'computer' }
  persist('checkmate.computer', computer)
}

function pauseComputer() {
  if (active(computer) && !computer.paused) saveComputer(transition(computer, { type: 'pause' }, computer.turn))
}

function computerMove(game) {
  const chess = position(game)
  const difficulty = game.difficulty ?? 'normal'
  const deadline = performance.now() + 420
  const timedOut = Symbol()

  function evaluate() {
    if (chess.isCheckmate()) return chess.turn() === 'w' ? 100000 : -100000
    if (chess.isDraw()) return 0
    return chess.board().flat().reduce((score, piece) => {
      if (!piece) return score
      const center = 7 - Math.abs(3.5 - 'abcdefgh'.indexOf(piece.square[0])) - Math.abs(4.5 - Number(piece.square[1]))
      return score + (piece.color === 'b' ? 1 : -1) * (values[piece.type] + (piece.type === 'k' ? 0 : center * 3))
    }, 0)
  }
  function orderedMoves() {
    return chess.moves({ verbose: true }).sort((a, b) =>
      (values[b.captured] ?? 0) + (values[b.promotion] ?? 0) -
      (values[a.captured] ?? 0) - (values[a.promotion] ?? 0))
  }

  function search(plies, alpha, beta) {
    if (performance.now() >= deadline) throw timedOut
    if (!plies || chess.isDraw()) return evaluate()
    const moves = orderedMoves()
    if (!moves.length) return evaluate()
    const maximizing = chess.turn() === 'b'
    let score = maximizing ? -Infinity : Infinity
    for (const move of moves) {
      chess.move(move)
      const value = search(plies - 1, alpha, beta)
      chess.undo()
      if (maximizing) {
        score = Math.max(score, value)
        alpha = Math.max(alpha, score)
      } else {
        score = Math.min(score, value)
        beta = Math.min(beta, score)
      }
      if (alpha >= beta) break
    }
    return score
  }

  const moves = orderedMoves()
  let best = moves[0]
  const maxDepth = { easy: 1, normal: 2, hard: 3 }[difficulty] ?? 2
  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      let bestScore = -Infinity
      let pick = best
      const candidates = [best, ...moves.filter(move => move !== best)]
      for (const move of candidates) {
        if (!move) break
        chess.move(move)
        const score = search(depth - 1, bestScore, Infinity) +
          (difficulty === 'easy' ? Math.random() * 140 : 0)
        chess.undo()
        if (score > bestScore) { bestScore = score; pick = move }
      }
      best = pick
    }
  } catch (error) {
    if (error !== timedOut) throw error
  }
  return best
}

function scheduleComputer() {
  const current = computer
  if (mode !== 'computer' || !active(current) || current.paused || current.turn !== 'b') return
  setTimeout(() => attempt(async () => {
    if (mode !== 'computer' || computer !== current || document.hidden) return
    const move = computerMove(current)
    if (move) await act({ type: 'move', from: move.from, to: move.to, promotion: move.promotion })
  }), computerDelays[current.difficulty] ?? computerDelays.normal)
}
function pauseLocal() {
  if (active(local) && !local.paused) setLocal(transition(local, { type: 'pause' }, local.turn))
}
function chooseMode(next) {
  if (mode === 'local' && next !== mode) pauseLocal()
  if (mode === 'computer' && next !== mode) pauseComputer()
  mode = next
  renderedGame = null
  if (next === 'online') {
    $('room-code').value = room ?? requestedRoom ?? saved(onlineSaveKey()) ?? saved('checkmate.room') ?? ''
  }
  if (next === 'computer') {
    const preferred = saved('checkmate.difficulty')
    const value = Object.hasOwn(difficultyNames, preferred) ? preferred : 'normal'
    $('setup').elements.difficulty.value = value
  }
  selected = ''
  message('')
  render()
  scheduleComputer()
}
for (const button of document.querySelectorAll('[data-mode]')) {
  button.hidden = guestOnly && button.dataset.mode === 'online'
  button.onclick = () => chooseMode(button.dataset.mode)
}
$('back-modes').onclick = () => chooseMode(null)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pauseLocal(); pauseComputer() }
  else render()
})
window.addEventListener('pagehide', () => { pauseLocal(); pauseComputer() })
window.addEventListener('pageshow', render)
setInterval(() => {
  const g = game()
  if (active(g) && !g.paused && g.minutes && (mode !== 'online' || connected) &&
      remaining(g, g.turn, Date.now() + (mode === 'online' ? offset : 0)) === 0) {
    void attempt(() => act({ type: 'tick' }))
  }
  renderClocks()
}, 300)

pauseLocal()
pauseComputer()
render()
if (!guestOnly) {
  await attempt(async () => {
    session = await api('session')
    render()
    if (requestedRoom && session.main && session.online) { chooseMode('online'); await connect(requestedRoom) }
  })
}
