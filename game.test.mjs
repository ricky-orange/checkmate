import test from 'node:test'
import assert from 'node:assert/strict'
import { newGame, position, remaining, transition } from './game.mjs'

const players = { w: { id: 'a' }, b: { id: 'b' } }
function play(game, from, to, now = 0, promotion) {
  return transition(game, { type: 'move', from, to, promotion }, game.turn, now)
}

test('合法走棋、將死與棋譜', () => {
  let game = newGame(players, 0, 0)
  assert.throws(() => play(game, 'e2', 'e5'))
  assert.throws(() => transition(game, { type: 'move', from: 'e7', to: 'e5' }, 'b', 0))
  for (const [from, to] of [['f2','f3'], ['e7','e5'], ['g2','g4'], ['d8','h4']]) game = play(game, from, to)
  assert.equal(game.result, 'b')
  assert.equal(game.reason, '將死')
  assert.match(position(game).pgn(), /Qh4#/)
})

test('易位、吃過路兵、升變與重複局面', () => {
  function sequence(moves) {
    return moves.reduce((game, [from, to, promotion]) => play(game, from, to, 0, promotion), newGame(players, 0, 0))
  }
  const castle = sequence([['e2','e4'],['a7','a6'],['g1','f3'],['a6','a5'],['f1','e2'],['b7','b6'],['e1','g1']])
  assert.equal(position(castle).get('f1').type, 'r')
  const capture = sequence([['e2','e4'],['a7','a6'],['e4','e5'],['d7','d5'],['e5','d6']])
  assert.equal(position(capture).get('d5'), undefined)
  const promotion = sequence([['a2','a4'],['h7','h5'],['a4','a5'],['h5','h4'],['a5','a6'],['h4','h3'],['a6','b7'],['h3','g2'],['b7','a8','n']])
  assert.equal(position(promotion).get('a8').type, 'n')
  const cycle = [['g1','f3'],['g8','f6'],['f3','g1'],['f6','g8']]
  assert.equal(sequence([...cycle, ...cycle]).result, 'draw')
})

test('時鐘分開計時，本機暫停可跨存檔續局', () => {
  let game = play(newGame(players, 1, 0), 'e2', 'e4', 3000)
  assert.equal(remaining(game, 'w', 4000), 57000)
  assert.equal(remaining(game, 'b', 4000), 59000)
  game = transition(game, { type: 'pause' }, 'b', 8000)
  game = JSON.parse(JSON.stringify(game))
  assert.equal(remaining(game, 'b', 90000), 55000)
  game = transition(game, { type: 'resume' }, 'b', 90000)
  assert.equal(remaining(game, 'b', 91000), 54000)
})

test('線上暫停須兩位玩家同意，單方提出時仍計時', () => {
  const pause = { type: 'pause', online: true }
  let game = newGame(players, 1, 0)
  game = transition(game, pause, 'w', 1000)
  assert.equal(game.paused, false)
  assert.equal(transition(game, pause, 'w', 2000), game)
  game = transition(game, pause, 'b', 3000)
  assert.equal(game.paused, true)
  assert.equal(remaining(game, 'w', 70000), 57000)
})

test('線上未暫停的倒數到期後無法再走棋', () => {
  const game = newGame(players, 1, 0)
  const final = play(game, 'e2', 'e4', 60000)
  assert.equal(final.result, 'b')
  assert.equal(final.reason, '超時')
  assert.equal(final.moves.length, 0)
})
