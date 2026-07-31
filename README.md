# SKELLZ NEON

The NYC milk-top street game (skelly / scully / caps), in 3D, for up to 8 players on one phone-friendly board.

A clone of `3d-multiplayer-mobile-game (7).zip` with every gameplay rule preserved, the bugs fixed, CPU bots that actually take their turns, and an installable mobile app.

## Running it

```bash
npm install && npm run dev
```

Open http://localhost:3000. No database, no environment variables, no setup.

```bash
npm run build && npm run start   # production
npm test                         # rules + physics + bot match tests
npm run typecheck && npm run lint
npm run icons                    # regenerate app icons + splash screens
```

## Installing it as a mobile app

SKELLZ is a full PWA — it installs to the home screen on **iPhone and Android**
straight from its URL, with no app store, developer account or Mac involved.

- **Android / Chrome** — the home page shows a one-tap **Install app** button
  (it captures `beforeinstallprompt` at module load, since that event often
  fires before React has mounted and is otherwise lost for the session).
- **iPhone / Safari** — iOS has no install API, so the card shows the actual
  Share → *Add to Home Screen* steps rather than a button that could not work.

Once installed it launches fullscreen with no browser chrome, its own icon and
splash screen, and holds a screen wake lock so the display never dims while an
opponent is taking their shot.

| Piece | Where |
| --- | --- |
| Manifest (icons, shortcuts, fullscreen, theme) | `src/app/manifest.ts` |
| Icons + iOS splash screens, generated from code | `scripts/make-icons.mjs` → `public/icons`, `public/splash` |
| Service worker | `public/sw.js` |
| SW registration + wake lock | `src/components/PwaProvider.tsx` |
| Install prompt / standalone detection | `src/game/pwa.ts`, `src/components/InstallCard.tsx` |
| Offline page | `public/offline.html` |

There are no image assets in the repo: `npm run icons` draws the mark
mathematically and writes real PNGs using a hand-rolled encoder (Node's `zlib`
is the only dependency), so every icon and launch image is reproducible.

### What the service worker will and won't cache

This is a live game, so the cache is deliberately conservative:

- `/api/**` — **never** cached. A stale room would desync the board.
- `/_next/static/**` — cache-first; those filenames are content-hashed.
- Navigations — network-first, falling back to the shell then `/offline.html`.

Client and server run the *same* physics to render a shot, so a stale document
(and with it stale bundle hashes) could make replays diverge. Hence
network-first HTML plus `skipWaiting`/`clients.claim()`: a new deploy takes
over immediately instead of lingering behind an old worker. The worker is only
registered in production builds.

Verified in a production build: SW active and controlling, 14 static assets
cached, **0** API responses cached, and CPU turns still resolving normally.

## What changed from the original

### The bots never played — fixed

This was the headline defect. The CPU AI ran in the host's browser on a 1500 ms
"thinking" timer, inside a `useEffect` whose dependency array included
`data.room` — a brand new object on every 1200 ms poll. Every poll tore the
timer down and restarted it, so it never reached 1500 ms and **a CPU never took
a single shot**. Any match with a bot in it simply stopped when the bot's turn
came around.

The bot is now resolved on the server (`src/game/bot.ts`, `action: "bot_shot"`):

- Every dependency of the trigger effect is a primitive, so polling can't cancel it.
- Any human in the room can drive the CPUs, not only the host — the permanent
  public rooms have no host at all, so bots there could never have run.
- The turn is guarded by `seq` plus a per-room lock, so when several players all
  notice the same CPU turn it still fires exactly once.
- Because the shot is resolved server-side, every client replays the identical
  deterministic physics.

The AI itself was also rebuilt. It now hunts the nearest enemy when it is a
KILLA (it used to just fire at the middle), prefers knocking a pinned enemy out
of the 2/4/6/8 for the 2–8 box bonus, and sizes its power from the actual
closed-form stopping distance `v₀ / friction` using the **current level's**
friction instead of a hardcoded 2.2 — so it no longer wildly overshoots on the
slick boroughs.

### Other bugs fixed

| Area | Bug |
| --- | --- |
| Boot | `src/db/index.ts` threw `DATABASE_URL is required` at import time. The game could not start at all without a Postgres instance. Replaced with an in-process store. |
| Multiplayer | `lastShot.shooterId` was written as the *requesting* player's id. For bot turns that was the host, so every other client replayed the CPU's shot as though the host took it and the 3D board desynced from the real state. |
| Replay | A shot replay ended only from the 3D render loop, but `requestAnimationFrame` is paused while a tab is hidden. Switching apps mid-shot wedged the match permanently. A timer-based watchdog now closes the shot out. |
| Audio | `initAudio()` was never called, so `audioCtx` stayed null and every sound hit an early return — the game was **completely silent**. Now unlocked on first tap. |
| Audio | Opponent and CPU shots carried no sound events into the scene; only your own flick made noise. |
| Rules | Breaking into a middle panel always started your run from box 3 regardless of whether you landed in the 2, 4, 6 or 8 — and set the route step inconsistently, so you landed on box 3 while still needing to make box 3. You now start from the number you actually hit. |
| Rooms | Joining a match already in progress was rejected outright, permanently locking newcomers out of the permanent public rooms. You now spectate and are dealt in next round. |
| Rooms | Nobody holds the host token in `PVPX` / `STRY`, so **Start match** and **Add CPU Bot** were impossible there — those rooms were stuck in the lobby forever. |
| Rooms | An unknown room code left the client on "Loading board…" forever. It now says the room doesn't exist. |
| Rooms | Room codes were generated without a uniqueness check, so a new room could silently hijack an existing one. |
| Story | The UI hardcoded a 5-level campaign (`Level x/5`, `level === 4`) while 20 boroughs were defined. All 20 are now playable. |
| Lobby | Copy said 6 players; the server allowed 8. Slots 7 and 8 also wrapped onto slots 1 and 2, stacking caps on top of each other on the chalk line. |
| Lobby | Co-op bots always joined team 2, making every team match lopsided. They now fill the shorter side. |
| Home | The Play PvP / Story buttons both reset your Free-for-all / Co-op choice back to Free-for-all, so a co-op match could never actually be created. |
| Home | The QR code read `window.location.href` during render, causing a server/client hydration mismatch. |
| Mobile | `userScalable: true` meant a pinch zoomed the *page* instead of the board, fighting the game's own pinch-to-zoom. |
| Render | Chalk decals are rasterised twice (colour + glow) with random jitter per pass, so every line drew as a faint double image with the glow offset. The jitter is now seeded. |
| Render | Each borough defines a `bg` colour that was never used — all 20 levels rendered on identical grey asphalt. |
| Render | Decal textures were never disposed, leaking multi-megabyte GPU textures on every level change. |
| Perf | A `console.log` ran inside the physics resolver on both server and client for every shot. |
| Cleanup | ~70 one-off `fix_*.js` / `patch_*.js` scratch scripts in the project root, plus dead CSS for a power slider the UI no longer has and an invisible placeholder mesh. |

## Architecture

```
src/game/board.ts    board geometry, the 27-step route, 20 NYC levels
src/game/sim.ts      deterministic physics + rules (runs on server AND client)
src/game/bot.ts      CPU aiming and target selection
src/game/audio.ts    WebAudio SFX
src/game/session.ts  localStorage session, read via useSyncExternalStore
src/server/store.ts  in-memory rooms/players/leaderboard + per-room locking
src/components/      Scene.tsx (three.js board) · GameClient.tsx (UI + netcode)
src/app/api/         room lifecycle and turn actions
```

`resolveShot()` is deterministic and pure. The server resolves the authoritative
shot and stores `{angle, power, shooterId}`; every client re-runs the same
function to render an identical replay, so only ~40 bytes move per turn instead
of a physics stream.

### Deployment note

Room state is in memory (`src/server/store.ts`), which is what makes this
zero-config. It must therefore run as a **single instance** — `render.yaml`
pins `numInstances: 1`. To scale horizontally, move that module to Redis or
Postgres; nothing else needs to change.

## Tests

`npm test` covers the physics being deterministic and non-mutating, each rule
that was fixed, and — as the regression test for the headline bug — full
CPU-vs-CPU matches across several seeds in story, free-for-all and co-op modes,
asserting they actually reach a KILLA and finish.
