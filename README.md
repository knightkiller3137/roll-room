# Roll Room

Real-time multiplayer Ludo for friends. One Node.js process serves the page and runs the game over WebSocket.
The server rolls every die and validates every move; the browser only displays state.

## Requirements

**To run or deploy**
- Node.js 18 or newer (Docker image uses Node 22). One dependency: `ws`.
- A host that allows a long-running process and WebSocket connections (Render, Railway, Fly.io, a VPS, any container host).
  Static or serverless-only hosts (GitHub Pages, Netlify, Vercel functions) will not work.
- HTTPS, so the page uses `wss://` and browsers allow clipboard and `crypto.randomUUID`. Most platforms add this for you.
- Roughly 128 MB RAM and a fraction of a CPU for dozens of simultaneous rooms.
- **Run exactly one instance.** Rooms live in that process's memory. Restarts and idle-sleep end active rooms.

**For players**
- Any modern browser (Chrome, Safari, Firefox, Edge) on phone or desktop. No install, no account.

## Run locally

    npm install
    npm start            # http://localhost:3000
    npm test             # rules + full bot-played matches

To test with several players on one computer, use separate browser profiles or a private window per player
(player identity is stored in each browser's localStorage).

## Deploy

**Render (Docker):** push this folder to a Git repo, then New > Blueprint (uses `render.yaml`), or New > Web Service > Docker.
**Railway / Fly.io / any container host:** point at the repo; the `Dockerfile` is detected. Expose the port from `PORT`.
**VPS:** `npm ci --omit=dev && PORT=3000 node server.js` under pm2 or systemd, behind Caddy or nginx with HTTPS.
nginx needs the WebSocket upgrade headers on `/api/ws`.

After deploy, open the URL, create a room, and share the invite link.

## Configuration (environment variables, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on (hosts usually set this) |
| `ALLOWED_ORIGINS` | any | Comma-separated origins allowed to open the WebSocket, e.g. `https://rollroom.example.com` |
| `TURN_TIMEOUT_MS` | 0 (off) | Auto-play a connected player who stays idle this long |
| `DISCONNECT_AUTOPLAY_MS` | 6000 | Delay before the server plays for a disconnected player |
| `PASS_DELAY_MS` | 1200 | How long a no-move roll stays on screen |
| `MAX_ROOMS` | 2000 | Cap on simultaneous rooms |
| `ROOM_TTL_MS` | 10800000 | Empty rooms are deleted after this idle time |
| `RATE_LIMIT_PER_SEC` | 10 | Per-connection message rate |

## Look and feel
Classic cross-shaped Ludo board with the four classic colors (red top-left, green top-right, yellow bottom-right, blue bottom-left),
heart-shaped tokens, heart-marked safe squares and a love theme throughout. Each token travels the classic 56 moves:
51 track squares, a private 5-square home column, then the center.

## Behaviour notes
- 2 to 4 players; first two seats are opposite colors. Owner starts once all other players are ready.
- Rules: 6 to leave base, 6 rolls again, three 6s end the turn, captures send tokens to base, same-color pairs are blockades,
  safe cells (start squares and heart-marked cells) cannot be captured on, exact roll to finish. First player with four tokens home wins.
- Gentle start (optional room setting): all four tokens in base after three turns means the next roll is a shown, guaranteed 6.
- A disconnected player is auto-played by the server and can resume by reopening the link. Leaving mid-game forfeits.
- Not included: accounts, persistence across restarts, horizontal scaling (needs a shared store plus sticky routing).
