'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');

const tok = (color, step, id) => ({ id: id || `${color}-${step}-${Math.random()}`, color, step });

test('needs a 6 to leave base', () => {
  const t = [tok('green', -1)];
  assert.equal(G.legalMoves(t, 'green', 5).length, 0);
  assert.equal(G.legalMoves(t, 'green', 6).length, 1);
});

test('exact roll needed to finish', () => {
  const t = [tok('green', 53)];
  assert.equal(G.legalMoves(t, 'green', 4).length, 0);
  assert.equal(G.legalMoves(t, 'green', 3).length, 1);
});

test('captures on a normal cell', () => {
  const g = tok('green', 3), y = tok('yellow', 44); // yellow on track index 5
  const cap = G.applyMove([g, y], g, 2);
  assert.equal(g.step, 5);
  assert.deepEqual(cap, [y]);
  assert.equal(y.step, -1);
});

test('no capture on a safe cell', () => {
  const g = tok('green', 6), y = tok('yellow', 47); // yellow on index 8 (safe)
  const cap = G.applyMove([g, y], g, 2);
  assert.equal(cap.length, 0);
  assert.equal(y.step, 47);
});

test('blockade stops passing and landing', () => {
  const g = tok('green', 3);
  const b = [g, tok('yellow', 44), tok('yellow', 44)]; // yellow pair on index 5
  assert.equal(G.legalMoves(b, 'green', 1).length, 1); // lands on 4
  assert.equal(G.legalMoves(b, 'green', 2).length, 0); // lands on blockade
  assert.equal(G.legalMoves(b, 'green', 3).length, 0); // passes blockade
});

test('blockade on own start stops entering', () => {
  const t = [tok('green', -1), tok('blue', 26), tok('blue', 26)]; // blue pair on index 0
  assert.equal(G.legalMoves(t, 'green', 6).length, 0);
});

test('classic path: 51 track cells then a private lane', () => {
  assert.equal(G.FINISH, 56);
  assert.equal(G.LAST_TRACK_STEP, 50);
});

test('home lane is private', () => {
  const g = tok('green', 48), y = tok('yellow', 39), y2 = tok('yellow', 39);
  assert.equal(G.legalMoves([g, y, y2], 'green', 5).length, 1);
});
