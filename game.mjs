import { Chess } from 'chess.js'

export function position(game) {
  const chess = new Chess()
  for (const move of game.moves ?? []) chess.move(move)
  return chess
}

export function newGame(players, minutes, now = Date.now()) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 180) throw Error('時間須為 1 至 180 分鐘，或不限時')
  return { players, minutes, moves: [], turn: 'w', clocks: { w: minutes * 60000, b: minutes * 60000 }, started: now, paused: !players.b, version: 0 }
}

export function remaining(game, side, now = Date.now()) {
  const elapsed = game.turn === side && !game.paused && !game.result ? Math.max(0, now - game.started) : 0
  return Math.max(0, game.clocks[side] - elapsed)
}

export function transition(game, action, side, now = Date.now()) {
  if (!game.players.b || game.result) return game
  const chess = position(game)
  const next = { ...game, version: game.version + 1 }
  const opponent = game.turn === 'w' ? 'b' : 'w'
  const left = remaining(game, game.turn, now)
  if (game.minutes && left === 0) {
    return { ...next, clocks: { ...game.clocks, [game.turn]: 0 }, result: opponent, reason: '超時' }
  }
  if (action.type === 'tick') return game
  if (action.type === 'resign') return { ...next, clocks: { ...game.clocks, [game.turn]: left }, result: side === 'w' ? 'b' : 'w', reason: '認輸' }
  if (action.type === 'pause') {
    if (game.paused) return game
    if (action.online && !game.pauseBy) return { ...next, pauseBy: side }
    if (action.online && game.pauseBy === side) return game
    return { ...next, paused: true, pauseBy: '', clocks: { ...game.clocks, [game.turn]: left } }
  }
  if (action.type === 'resume') {
    return game.paused ? { ...next, paused: false, started: now } : game
  }
  if (action.type !== 'move' || game.paused || side !== game.turn) throw Error('目前不能走棋')
  const { from, to, promotion } = action
  chess.move({ from, to, promotion })
  const result = chess.isCheckmate() ? side : chess.isDraw() ? 'draw' : ''
  return {
    ...next, moves: [...(game.moves ?? []), { from, to, ...(promotion ? { promotion } : {}) }],
    turn: chess.turn(), started: now, clocks: { ...game.clocks, [side]: left },
    result, reason: result === 'draw' ? '和棋' : result ? '將死' : '',
  }
}
