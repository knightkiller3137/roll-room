'use strict';
process.env.PASS_DELAY_MS = '3';
process.env.RATE_LIMIT_PER_SEC = '100000';
process.env.DISCONNECT_AUTOPLAY_MS = '20';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { start } = require('../server');
const G = require('../game');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 60000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(10); }
  throw new Error('timeout');
}

function client(port, secret, bot) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const c = { ws, id: null, code: null, state: null, errors: [], chat: [] };
  let acted = -1;
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'room_joined') { c.id = m.playerId; c.code = m.roomCode; }
    if (m.type === 'error') c.errors.push(m);
    if (m.type === 'chat_message') c.chat.push(m.message);
    if (m.type !== 'room_state') return;
    c.state = m;
    check(m);
    const g = m.game;
    if (bot && m.room.phase === 'playing' && g.currentPlayerId === c.id && m.revision !== acted) {
      acted = m.revision;
      if (g.diceValue == null) c.send({ type: 'roll' });
      else if (g.legalMoves.length) c.send({ type: 'move', tokenId: g.legalMoves[Math.floor(Math.random() * g.legalMoves.length)] });
    }
  });
  c.opened = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify({ ...o, playerId: secret, roomCode: c.code || o.roomCode, requestId: Math.random().toString(36).slice(2) }));
  return c;
}

function check(m) {
  if (m.room.phase === 'lobby') return;
  const colorOf = Object.fromEntries(m.players.map((p) => [p.id, p.color]));
  const cells = {};
  for (const t of m.game.tokens) {
    assert.ok(t.step >= -1 && t.step <= 57, 'step range');
    if (t.step >= 0 && t.step <= 51) {
      const idx = G.trackIndex(colorOf[t.playerId], t.step);
      (cells[idx] = cells[idx] || new Set()).add(colorOf[t.playerId]);
    }
  }
  for (const [idx, set] of Object.entries(cells)) if (!G.SAFE.has(Number(idx))) assert.ok(set.size <= 1, `mixed colors on unsafe cell ${idx}`);
}

test('full 4-player gentle match with bots reaches a winner', { timeout: 120000 }, async () => {
  const app = start(0);
  await new Promise((r) => app.server.on('listening', r));
  const port = app.server.address().port;
  const cs = ['secret-player-1', 'secret-player-2', 'secret-player-3', 'secret-player-4'].map((s) => client(port, s, true));
  await Promise.all(cs.map((c) => c.opened));
  cs[0].send({ type: 'create_room', name: 'Ann', maxPlayers: 4, diceMode: 'gentle' });
  await waitFor(() => cs[0].code);
  ['Bob', 'Cy', 'Di'].forEach((n, i) => cs[i + 1].send({ type: 'join_room', roomCode: cs[0].code, name: n }));
  await waitFor(() => cs[0].state && cs[0].state.players.length === 4);
  cs[1].send({ type: 'send_chat', text: 'hello   room' });
  await waitFor(() => cs[0].chat.some((m) => m.text === 'hello room'));
  cs[0].send({ type: 'start_game' });
  await waitFor(() => cs[0].errors.some((e) => e.code === 'not_ready'));
  [1, 2, 3].forEach((i) => cs[i].send({ type: 'set_ready', ready: true }));
  await sleep(50);
  cs[0].send({ type: 'start_game' });
  const final = await waitFor(() => cs[0].state && cs[0].state.room.phase === 'finished' && cs[0].state, 100000);
  const w = final.game.winnerId;
  assert.ok(w);
  assert.equal(final.game.tokens.filter((t) => t.playerId === w && t.step === 57).length, 4);
  cs.forEach((c) => c.ws.close());
  await app.close();
});

test('disconnected player is auto-played; join errors are reported', { timeout: 120000 }, async () => {
  const app = start(0);
  await new Promise((r) => app.server.on('listening', r));
  const port = app.server.address().port;
  const a = client(port, 'secret-aaaa-1', true), b = client(port, 'secret-bbbb-2', false), z = client(port, 'secret-zzzz-9', false);
  await Promise.all([a.opened, b.opened, z.opened]);
  z.send({ type: 'join_room', roomCode: 'NOPE22', name: 'Z' });
  await waitFor(() => z.errors.some((e) => e.code === 'room_not_found' && e.fatal));
  a.send({ type: 'create_room', name: 'A', maxPlayers: 2 });
  await waitFor(() => a.code);
  b.send({ type: 'join_room', roomCode: a.code, name: 'B' });
  await waitFor(() => a.state && a.state.players.length === 2);
  b.send({ type: 'set_ready', ready: true });
  await sleep(30);
  a.send({ type: 'start_game' });
  await waitFor(() => a.state.room.phase === 'playing');
  z.send({ type: 'join_room', roomCode: a.code, name: 'Z' });
  await waitFor(() => z.errors.some((e) => e.code === 'game_started'));
  b.ws.close(); // B vanishes; server must play for B
  const final = await waitFor(() => a.state.room.phase === 'finished' && a.state, 100000);
  assert.ok(final.game.winnerId);
  a.ws.close(); z.ws.close();
  await app.close();
});
