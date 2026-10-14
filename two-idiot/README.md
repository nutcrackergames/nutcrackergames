# Two Idiots, One Body

A colorful browser-based 3D co-op platformer prototype. One player controls the left leg, another controls the right leg, and the shared body must reach the finish line before the timer runs out.

## Run locally

Requirements: Node.js 18+

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser tabs/devices. One player clicks **Create Room** and shares the room code; the other enters the code and clicks **Join Room**. Both players must be connected before **Start Course** is enabled.

## Controls

- Left-leg player: `W` / `S` or arrow keys to push forward/backward.
- Right-leg player: `I` / `K` (arrow keys also work as shared movement input).
- `Space`: jump.
- Mobile: on-screen backward / jump / forward controls.

## Deployment

Deploy as a Node.js web service on a host that supports persistent WebSocket connections (for example Render). Build command: `npm install`. Start command: `npm start`. Do not deploy as a static site; the room-code multiplayer requires the Node server.

## Current prototype scope

- Three.js 3D rendering, cartoon character, obstacle course, camera follow, animated hazards and responsive UI.
- WebSocket room codes and a server-side shared movement state for two players.
- Server-side timer, falls, checkpoints, and finish trigger.
- A local practice mode for testing the course.

This is a prototype foundation, not a production-ready competitive release. Before public launch, test mobile input on real devices, improve collision geometry for individual hazards, add persistent account-based personal-best storage, and load-test multiplayer rooms. The included server uses lightweight arcade movement simulation; Rapier is installed as the planned physics-engine dependency but the current server movement loop is intentionally simplified.
