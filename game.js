'use strict';
/*
  Roll Room — pure Ludo rules. No networking, no randomness, easy to unit test.

  Board model (matches the client):
    - 52 shared track cells, indexed 0..51 clockwise.
    - Each color enters the track at its own start index.
    - Token step: -1 = in base, 0..50 = steps along the track from that color's
      start (the last track cell is the tip of its own arm), 51..55 = private
      home lane, 56 = finished (the center). Classic Ludo: 56 moves from start to home.
*/

const COLORS = ['green', 'yellow', 'blue', 'red'];
const START = { green: 0, yellow: 13, blue: 26, red: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const TRACK_LEN = 52;
const LAST_TRACK_STEP = 50;
const FINISH = 56;

const trackIndex = (color, step) => (START[color] + step) % TRACK_LEN;
const onTrack = (t) => t.step >= 0 && t.step <= LAST_TRACK_STEP;

/** Step a token would land on for this roll, or null if the roll cannot be used. */
function destination(token, roll) {
  if (token.step === -1) return roll === 6 ? 0 : null;
  const dest = token.step + roll;
  return dest > FINISH ? null : dest;
}

/** True if an opponent blockade (2+ tokens of one color) sits on any track cell passed or landed on. */
function blockedBy(tokens, mover, toStep) {
  const from = mover.step === -1 ? 0 : mover.step + 1;
  const to = Math.min(toStep, LAST_TRACK_STEP);
  for (let s = from; s <= to; s++) {
    const idx = trackIndex(mover.color, s);
    const counts = {};
    for (const t of tokens) {
      if (t.color === mover.color || !onTrack(t) || trackIndex(t.color, t.step) !== idx) continue;
      counts[t.color] = (counts[t.color] || 0) + 1;
      if (counts[t.color] >= 2) return true;
    }
  }
  return false;
}

/** Tokens of `color` that may legally move with this roll. */
function legalMoves(tokens, color, roll) {
  return tokens.filter((t) => {
    if (t.color !== color) return false;
    const d = destination(t, roll);
    return d !== null && !blockedBy(tokens, t, d);
  });
}

/** Apply a (previously validated) move. Returns the list of captured tokens. */
function applyMove(tokens, token, roll) {
  const d = destination(token, roll);
  token.step = d;
  const captured = [];
  if (d >= 0 && d <= LAST_TRACK_STEP) {
    const idx = trackIndex(token.color, d);
    if (!SAFE.has(idx)) {
      for (const t of tokens) {
        if (t !== token && t.color !== token.color && onTrack(t) && trackIndex(t.color, t.step) === idx) {
          t.step = -1;
          captured.push(t);
        }
      }
    }
  }
  return captured;
}

const allHome = (tokens, color) => tokens.filter((t) => t.color === color).every((t) => t.step === FINISH);

module.exports = { COLORS, START, SAFE, TRACK_LEN, LAST_TRACK_STEP, FINISH, trackIndex, onTrack, destination, blockedBy, legalMoves, applyMove, allHome };
