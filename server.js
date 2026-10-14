'use strict';
/*
  Roll Room server — serves the page and runs authoritative game rooms over WebSocket.
  The server rolls every die, validates every move and keeps all room state in memory.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);

const PORT = num('PORT', 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_TIMEOUT_MS = num('TURN_TIMEOUT_MS', 0);               // 0 = never auto-play a connected player
const DISCONNECT_AUTOPLAY_MS = num('DISCONNECT_AUTOPLAY_MS', 6000);
const PASS_DELAY_MS = num('PASS_DELAY_MS', 1200);                // how long a no-move roll stays visible
const MAX_ROOMS = num('MAX_ROOMS', 2000);
const RATE_PER_SEC = num('RATE_LIMIT_PER_SEC', 10);                // per-connection message budget (burst = 3x)
const ROOM_TTL_MS = num('ROOM_TTL_MS', 3 * 60 * 60 * 1000);      // idle, empty rooms are deleted after this
const LOBBY_GRACE_MS = 90 * 1000;
const JOIN_ORDER = ['green', 'blue', 'yellow', 'red'];            // first two players sit opposite each other
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();

/* ---------- small helpers ---------- */
const pub = (secret, code) => crypto.createHash('sha256').update(code + ':' + secret).digest('hex').slice(0, 12);
const cleanText = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanName = (s) => cleanText(s).slice(0, 24);
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const wsSend = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const fail = (ws, msg, code, message, fatal = false) => wsSend(ws, { type: 'error', code, message, fatal, requestId: msg && msg.requestId });

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

/* ---------- room state ---------- */
function stateOf(room) {
  const g = room.game;
  return {
    type: 'room_state',
    room: { code: room.code, maxPlayers: room.maxPlayers, phase: room.phase, diceMode: room.diceMode, ownerId: room.ownerId },
    players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, connected: p.sockets.size > 0, ready: p.ready })),
    game: g
      ? { currentPlayerId: g.currentPlayerId, diceValue: g.diceValue, lastValue: g.lastValue, lastRollText: g.lastRollText, consecutiveSixes: g.consecutiveSixes,
          tokens: g.tokens.map((t) => ({ playerId: t.playerId, id: t.id, step: t.step })), legalMoves: g.legalMoves, winnerId: g.winnerId }
      : { currentPlayerId: null, diceValue: null, lastValue: null, lastRollText: '', consecutiveSixes: 0, tokens: [], legalMoves: [], winnerId: null },
    chat: room.chat.slice(-80),
    revision: room.revision,
  };
}

function commit(room) {
  room.lastActive = Date.now();
  room.revision++;
  const s = JSON.stringify(stateOf(room));
  for (const p of room.players) for (const ws of p.sockets) if (ws.readyState === 1) ws.send(s);
  scheduleAuto(room);
}

function pushChat(room, e) {
  const entry = { id: ++room.chatSeq, at: Date.now(), ...e };
  room.chat.push(entry);
  if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
  return entry;
}
const addSystem = (room, text) => pushChat(room, { playerId: 'system', name: 'Room', text, system: true });

function destroyRoom(room) {
  clearTimeout(room.passTimer);
  clearTimeout(room.autoTimer);
  rooms.delete(room.code);
}

function addPlayer(room, secret, rawName) {
  let name = rawName || 'Player';
  let n = 2;
  while (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${(rawName || 'Player').slice(0, 21)} ${n++}`;
  const color = JOIN_ORDER.find((c) => !room.players.some((p) => p.color === c));
  const player = { secret, id: pub(secret, room.code), name, color, ready: false, sockets: new Set(), disconnectedAt: 0, baseTurns: 0 };
  room.players.push(player);
  return player;
}

function bind(ws, room, player) {
  if (ws.room && ws.room !== room) detach(ws, true);
  ws.room = room;
  ws.player = player;
  player.sockets.add(ws);
  player.disconnectedAt = 0;
}

function detach(ws, switching) {
  const room = ws.room, p = ws.player;
  ws.room = null;
  ws.player = null;
  if (!room || !p) return;
  p.sockets.delete(ws);
  if (p.sockets.size === 0) {
    if (switching && room.phase === 'lobby') return removePlayer(room, p);
    p.disconnectedAt = Date.now();
  }
  if (rooms.has(room.code)) commit(room);
}

/** Remove a player from a room (leaving the lobby, or forfeiting a running match). */
function removePlayer(room, p) {
  const idx = room.players.indexOf(p);
  if (idx < 0) return;
  for (const ws of p.sockets) { if (ws.player === p) { ws.room = null; ws.player = null; } }
  p.sockets.clear();
  room.players.splice(idx, 1);
  if (room.players.length === 0) return destroyRoom(room);
  if (room.ownerId === p.id) room.ownerId = room.players[0].id;

  if (room.phase === 'playing') {
    const g = room.game;
    const wasCurrent = g.currentPlayerId === p.id;
    const oi = g.order.indexOf(p.id);
    g.tokens = g.tokens.filter((t) => t.playerId !== p.id);
    g.order.splice(oi, 1);
    addSystem(room, `${p.name} left the game.`);
    if (g.order.length <= 1) {
      const w = room.players.find((x) => x.id === g.order[0]);
      room.phase = 'finished';
      g.winnerId = w ? w.id : null;
      g.diceValue = null; g.legalMoves = []; g.passing = false;
      clearTimeout(room.passTimer);
      if (w) { g.lastRollText = `${w.name} wins — everyone else left.`; addSystem(room, `${w.name} wins!`); }
    } else if (wasCurrent) {
      clearTimeout(room.passTimer);
      g.passing = false; g.diceValue = null; g.legalMoves = []; g.consecutiveSixes = 0;
      g.currentPlayerId = g.order[oi % g.order.length];
    }
  } else {
    addSystem(room, `${p.name} left the room.`);
  }
  commit(room);
}

/* ---------- game flow ---------- */
const currentPlayer = (room) => room.players.find((p) => p.id === room.game.currentPlayerId);

function startGame(room) {
  const players = [...room.players].sort((a, b) => G.START[a.color] - G.START[b.color]);
  const tokens = [];
  for (const p of players) for (let i = 1; i <= 4; i++) tokens.push({ id: `${p.id}-t${i}`, playerId: p.id, color: p.color, step: -1 });
  const first = players[crypto.randomInt(players.length)];
  room.phase = 'playing';
  room.game = { order: players.map((p) => p.id), tokens, currentPlayerId: first.id, diceValue: null, lastValue: null,
    lastRollText: `${first.name} goes first.`, consecutiveSixes: 0, legalMoves: [], winnerId: null, passing: false };
  players.forEach((p) => { p.baseTurns = 0; });
  addSystem(room, `The game has started. ${first.name} goes first.`);
  commit(room);
}

function rollDie(room, p) {
  const g = room.game;
  const allBase = g.tokens.filter((t) => t.playerId === p.id).every((t) => t.step === -1);
  let value, forced = false;
  if (room.diceMode === 'gentle' && allBase && p.baseTurns >= 3) { value = 6; forced = true; }
  else value = crypto.randomInt(1, 7);

  g.diceValue = value;
  g.lastValue = value;
  g.consecutiveSixes = value === 6 ? g.consecutiveSixes + 1 : 0;
  const prefix = forced ? `Gentle start: ${p.name} gets a guaranteed 6.` : `${p.name} rolled ${value}.`;

  if (g.consecutiveSixes >= 3) {
    g.legalMoves = [];
    g.lastRollText = `${prefix} Third six in a row — turn ends.`;
    return schedulePass(room, false);
  }
  const legal = G.legalMoves(g.tokens, p.color, value);
  g.legalMoves = legal.map((t) => t.id);
  if (!legal.length) {
    g.lastRollText = `${prefix} No legal move.`;
    return schedulePass(room, value === 6);
  }
  g.lastRollText = prefix;
  commit(room);
}

/** Show a no-move roll briefly, then advance. */
function schedulePass(room, extra) {
  const g = room.game;
  g.passing = true;
  commit(room);
  clearTimeout(room.passTimer);
  room.passTimer = setTimeout(() => {
    if (room.phase !== 'playing') return;
    g.passing = false;
    endTurn(room, extra);
  }, PASS_DELAY_MS);
}

function endTurn(room, extra) {
  const g = room.game;
  const p = currentPlayer(room);
  g.diceValue = null;
  g.legalMoves = [];
  if (!extra) {
    if (p) {
      const allBase = g.tokens.filter((t) => t.playerId === p.id).every((t) => t.step === -1);
      p.baseTurns = allBase ? p.baseTurns + 1 : 0;
    }
    g.consecutiveSixes = 0;
    g.currentPlayerId = g.order[(g.order.indexOf(g.currentPlayerId) + 1) % g.order.length];
  }
  commit(room);
}

function doMove(room, p, tokenId) {
  const g = room.game;
  const token = g.tokens.find((t) => t.id === tokenId && t.playerId === p.id);
  if (!token || !g.legalMoves.includes(tokenId)) return false;
  const value = g.diceValue;
  const was = token.step;
  const captured = G.applyMove(g.tokens, token, value);

  let text = was === -1 ? `${p.name} brought a token out.` : token.step === G.FINISH ? `${p.name} got a token home!` : `${p.name} moved ${value}.`;
  if (token.step === G.FINISH) addSystem(room, `${p.name} got a token home.`);
  for (const owner of new Set(captured.map((t) => t.playerId))) {
    const victim = room.players.find((x) => x.id === owner);
    const n = captured.filter((t) => t.playerId === owner).length;
    const line = `${p.name} captured ${victim ? victim.name + '’s' : 'a'} token${n > 1 ? 's' : ''}!`;
    text += ' ' + line;
    addSystem(room, line);
  }
  g.lastRollText = text;

  if (G.allHome(g.tokens, p.color)) {
    room.phase = 'finished';
    g.winnerId = p.id;
    g.diceValue = null;
    g.legalMoves = [];
    g.lastRollText = `${p.name} wins!`;
    addSystem(room, `${p.name} wins the match!`);
    return commit(room), true;
  }
  endTurn(room, value === 6);
  return true;
}

/* ---------- auto-play for disconnected (or optionally idle) players ---------- */
function scheduleAuto(room) {
  clearTimeout(room.autoTimer);
  room.autoTimer = null;
  if (room.phase !== 'playing' || room.game.passing) return;
  if (room.players.every((x) => x.sockets.size === 0)) return; // nobody here: pause the game
  const p = currentPlayer(room);
  if (!p) return;
  let delay;
  if (p.sockets.size === 0) delay = room.game.diceValue === null ? DISCONNECT_AUTOPLAY_MS : 900;
  else if (TURN_TIMEOUT_MS > 0) delay = TURN_TIMEOUT_MS;
  else return;
  room.autoTimer = setTimeout(() => autoStep(room, p.id), delay);
  if (room.autoTimer.unref) room.autoTimer.unref();
}

function autoStep(room, pid) {
  const g = room.game;
  if (room.phase !== 'playing' || g.passing || g.currentPlayerId !== pid) return;
  const p = currentPlayer(room);
  if (!p) return;
  if (g.diceValue === null) return rollDie(room, p);
  const legal = g.tokens.filter((t) => g.legalMoves.includes(t.id)).sort((a, b) => b.step - a.step);
  if (legal.length) doMove(room, p, legal[0].id);
}

/* ---------- message handling ---------- */
function roomAndPlayer(ws, msg, secret) {
  const code = normCode(msg.roomCode) || (ws.room && ws.room.code);
  const room = rooms.get(code);
  const player = room && room.players.find((p) => p.secret === secret);
  return { room, player };
}

function handle(ws, msg) {
  const t = msg.type;
  if (t === 'ping') return wsSend(ws, { type: 'pong' });
  if (t === 'hello') return;

  const secret = typeof msg.playerId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.playerId) ? msg.playerId : null;
  if (!secret) return fail(ws, msg, 'bad_identity', 'Missing or invalid player identity.', true);
  if (ws.secret && ws.secret !== secret) return fail(ws, msg, 'bad_identity', 'Player identity changed on this connection.', true);
  ws.secret = secret;

  switch (t) {
    case 'create_room': {
      if (rooms.size >= MAX_ROOMS) return fail(ws, msg, 'server_busy', 'The server is full right now. Try again in a few minutes.', true);
      const name = cleanName(msg.name);
      if (!name) return fail(ws, msg, 'bad_name', 'Enter a name to play.', true);
      const maxPlayers = Math.min(4, Math.max(2, parseInt(msg.maxPlayers, 10) || 4));
      const diceMode = msg.diceMode === 'gentle' ? 'gentle' : 'classic';
      const code = newCode();
      const room = { code, maxPlayers, diceMode, phase: 'lobby', ownerId: '', players: [], game: null, chat: [], chatSeq: 0,
        revision: 0, lastActive: Date.now(), passTimer: null, autoTimer: null };
      rooms.set(code, room);
      const player = addPlayer(room, secret, name);
      room.ownerId = player.id;
      bind(ws, room, player);
      wsSend(ws, { type: 'room_joined', roomCode: code, playerId: player.id });
      addSystem(room, `${player.name} created the room.`);
      return commit(room);
    }

    case 'join_room': {
      const room = rooms.get(normCode(msg.roomCode));
      if (!room) return fail(ws, msg, 'room_not_found', 'Room not found. Check the code and try again.', true);
      let player = room.players.find((p) => p.secret === secret);
      if (!player) {
        const name = cleanName(msg.name);
        if (!name) return fail(ws, msg, 'bad_name', 'Enter a name to play.', true);
        if (room.phase !== 'lobby') return fail(ws, msg, 'game_started', 'That game has already started.', true);
        if (room.players.length >= room.maxPlayers) return fail(ws, msg, 'room_full', 'That room is full.', true);
        player = addPlayer(room, secret, name);
        addSystem(room, `${player.name} joined.`);
      }
      bind(ws, room, player);
      wsSend(ws, { type: 'room_joined', roomCode: room.code, playerId: player.id });
      return commit(room);
    }

    case 'resume_room': {
      const { room, player } = roomAndPlayer(ws, msg, secret);
      if (!room || !player) return fail(ws, msg, 'room_not_found', 'That room is no longer available.', true);
      bind(ws, room, player);
      wsSend(ws, { type: 'room_joined', roomCode: room.code, playerId: player.id });
      return commit(room);
    }

    case 'leave_room': {
      const { room, player } = roomAndPlayer(ws, msg, secret);
      if (room && player) removePlayer(room, player); // silently ignore unknown rooms
      return;
    }
  }

  const { room, player } = roomAndPlayer(ws, msg, secret);
  if (!room || !player) return fail(ws, msg, 'not_in_room', 'You are not in that room anymore.', true);
  room.lastActive = Date.now();

  switch (t) {
    case 'set_ready': {
      if (room.phase !== 'lobby') return;
      player.ready = !!msg.ready;
      return commit(room);
    }
    case 'start_game': {
      if (room.phase !== 'lobby') return fail(ws, msg, 'bad_state', 'The game has already started.');
      if (room.ownerId !== player.id) return fail(ws, msg, 'not_owner', 'Only the room creator can start the game.');
      if (room.players.length < 2) return fail(ws, msg, 'need_players', 'You need at least 2 players to start.');
      const waiting = room.players.filter((p) => p.id !== room.ownerId && !p.ready);
      if (waiting.length) return fail(ws, msg, 'not_ready', `Waiting for ${waiting.map((p) => p.name).join(', ')} to be ready.`);
      return startGame(room);
    }
    case 'roll': {
      if (room.phase !== 'playing') return fail(ws, msg, 'bad_state', 'The game is not running.');
      const g = room.game;
      if (g.currentPlayerId !== player.id) return fail(ws, msg, 'not_your_turn', 'It is not your turn.');
      if (g.diceValue !== null || g.passing) return fail(ws, msg, 'bad_state', 'You already rolled — move a token.');
      return rollDie(room, player);
    }
    case 'move': {
      if (room.phase !== 'playing') return fail(ws, msg, 'bad_state', 'The game is not running.');
      const g = room.game;
      if (g.currentPlayerId !== player.id) return fail(ws, msg, 'not_your_turn', 'It is not your turn.');
      if (g.diceValue === null || g.passing) return fail(ws, msg, 'bad_state', 'Roll the dice first.');
      if (!doMove(room, player, String(msg.tokenId))) return fail(ws, msg, 'illegal_move', 'That token cannot move.');
      return;
    }
    case 'send_chat': {
      const text = cleanText(msg.text).slice(0, 280);
      if (!text) return;
      room.lastActive = Date.now();
      const entry = pushChat(room, { playerId: player.id, name: player.name, text });
      const s = JSON.stringify({ type: 'chat_message', message: entry });
      for (const p of room.players) for (const sock of p.sockets) if (sock.readyState === 1) sock.send(s);
      return;
    }
    default:
      return fail(ws, msg, 'unknown_type', 'Unknown message type.');
  }
}

function onClose(ws) {
  if (ws.room) detach(ws, false);
}

function rateOk(ws) {
  const now = Date.now();
  ws.bucket = Math.min(RATE_PER_SEC * 3, ws.bucket + ((now - ws.lastRefill) / 1000) * RATE_PER_SEC);
  ws.lastRefill = now;
  if (ws.bucket < 1) return false;
  ws.bucket -= 1;
  return true;
}

/* ---------- HTTP + WebSocket bootstrap ---------- */
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function start(port = PORT) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : INDEX_HTML);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const wss = new WebSocketServer({
    server, path: '/api/ws', maxPayload: 4096, perMessageDeflate: false,
    verifyClient: (info) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(info.origin),
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.bucket = RATE_PER_SEC * 3;
    ws.lastRefill = Date.now();
    ws.room = null; ws.player = null; ws.secret = null;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!rateOk(ws)) return wsSend(ws, { type: 'error', code: 'rate_limited', message: 'Slow down a little.' });
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      try { handle(ws, msg); }
      catch (e) { console.error('handler error', e); fail(ws, msg, 'server_error', 'Something went wrong on the server.'); }
    });
    ws.on('close', () => onClose(ws));
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);

  const janitor = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (room.phase === 'lobby') {
        for (const p of [...room.players]) if (p.sockets.size === 0 && p.disconnectedAt && now - p.disconnectedAt > LOBBY_GRACE_MS && rooms.has(room.code)) removePlayer(room, p);
        if (!rooms.has(room.code)) continue;
      }
      const empty = room.players.every((p) => p.sockets.size === 0);
      const idle = now - room.lastActive;
      if (empty && (idle > ROOM_TTL_MS || (room.phase === 'finished' && idle > 20 * 60 * 1000))) destroyRoom(room);
    }
  }, 20000);
  heartbeat.unref();
  janitor.unref();

  server.listen(port, '0.0.0.0');
  const close = () => new Promise((resolve) => {
    clearInterval(heartbeat); clearInterval(janitor);
    for (const room of [...rooms.values()]) destroyRoom(room);
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => server.close(() => resolve()));
  });
  return { server, wss, close };
}

if (require.main === module) {
  const app = start(PORT);
  app.server.on('listening', () => console.log(`Roll Room listening on :${app.server.address().port}`));
  const stop = () => { console.log('Shutting down…'); app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { start, rooms };
