# Nutcracker Games — 3D Gaming Room

A static HTML/CSS/JavaScript website using Three.js from a CDN. It is designed for GitHub Pages.

## Publish on GitHub Pages
1. Upload `index.html`, `styles.css`, `main.js`, `games.js`, and `favicon.svg` to the repository root (or upload the whole folder's contents).
2. In GitHub, open **Settings → Pages** and publish from your desired branch and root folder.
3. If using a custom domain, keep your existing DNS and `CNAME` configuration in place.

## Configure the real game URLs
Edit `games.js`. Every `url` should point to the actual playable page for that game. Mudline is set to the known URL `https://mudline.nutcrackergames.fun/`. The other entries are starter catalogue entries and currently point to the main website until you replace them with each game's exact URL. Remove entries that are not live yet.

The 3D room and game-case interactions work independently of the catalogue. Clicking a case selects it and starts the launch flow; the library Play button uses the configured URL.

## Important embedding note
Some games may send headers such as `X-Frame-Options` or a restrictive `Content-Security-Policy` that prevents them from loading inside an iframe. Browsers do not allow JavaScript on this site to reliably inspect cross-origin frame errors. The site therefore provides a direct-open fallback if the game does not appear to load. For a seamless embedded launch, configure each game host to permit framing by your site, and verify that multiplayer/WebSocket and fullscreen features work in the iframe.

## Notes
- Three.js is loaded from jsDelivr; the first visit needs an internet connection.
- The page has a CSS game-library fallback if WebGL initialization fails.
- The design reduces antialiasing, shadows, and pixel ratio on smaller devices.
- The scene is a lightweight procedural 3D environment, not a downloaded heavy model.
