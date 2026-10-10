# PEN FIGHT: CLASSROOM WARS

Single-file HTML5 game (`index.html`): Canvas + CSS + JS, physics by Matter.js 0.19 (loaded from cdnjs, jsDelivr fallback).
Fonts (Bowlby One, Baloo 2) load from Google Fonts; system fonts are used if offline.

## Run locally
Open `index.html` in a browser (needs internet once for Matter.js), or serve the folder:

    python3 -m http.server 8000     # then open http://localhost:8000

## Publish on a static host
Upload `index.html` to Netlify Drop, GitHub Pages, Cloudflare Pages or Vercel (static). No build step, no backend.

## Controls
- Drag back from your pen, release to flick. Esc = pause. R = restart (from pause/result screen).

## Not implemented
- Online multiplayer (no backend; code is turn-based so it can be added later).

## Online + voice (new)
Main menu > ONLINE + VOICE. One player taps CREATE ROOM and shares the 5-letter code; the friend enters it and taps JOIN.
Peer-to-peer WebRTC through PeerJS's free public signalling server (no backend of your own). The host's device runs the
physics; the friend's device mirrors it and sends its flicks to the host.
- Voice chat needs a secure origin: serve over HTTPS (Netlify, GitHub Pages) or http://localhost. It will not work from file:// or content://.
- Some mobile networks block direct peer links; a free public TURN relay is configured as a fallback but is best-effort.
