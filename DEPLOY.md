# Get a permanent SKELLZ link (deploy to Render)

This gives you a link like `https://skellz-neon.onrender.com` that works
**forever**, whether your PC is on or off — and because it's `https`, the
**Install app** button works, so it goes on your phone's home screen like a
real app.

It's free and needs no credit card.

There are two account steps in here (GitHub + Render). Those are the only steps
nobody can do for you — everything else in this project is already configured
and committed.

Takes about 5 minutes, once.

---

## Part 1 — put the game on GitHub

Unlike DUKE$DEFENSE, there's **no drag-and-drop this time**. The folder is
already a git repo with a commit in it and the remote pointed at GitHub, so all
you do is make the empty repo and Claude pushes it.

1. Go to **https://github.com/new**
2. **Repository name:** `skellz-neon`
3. Public or Private — either works with Render.
4. **Do NOT tick** "Add a README", `.gitignore`, or a license.
   The repo has to be completely empty or the push will be rejected.
5. Click **Create repository**.

Then push (or just tell Claude "done" and it runs this for you):

```bash
git -C "D:/CLAUDE HACKS/hackingtool-plugin-main/skelzie/game" push -u origin main
```

If the repo ended up under a different account or name, repoint it first:

```bash
git -C "D:/CLAUDE HACKS/hackingtool-plugin-main/skelzie/game" remote set-url origin https://github.com/YOURNAME/skellz-neon.git
```

---

## Part 2 — deploy on Render

1. Go to **https://render.com** → **Get Started**.
   Choose **"Sign in with GitHub"** so it can see your repos automatically.
2. On the dashboard: **New +** → **Blueprint**.
3. Pick the **`skellz-neon`** repository.
4. Render reads the included **`render.yaml`** and shows a service called
   *skellz-neon* on the **Free** plan. Click **Apply**.
5. Wait 2–3 minutes for the first build (it runs `npm ci && npm run build`).
   When the status goes **Live**, your URL is at the top:

   ```
   https://skellz-neon.onrender.com
   ```

**That's the permanent link.** Open it on your phone and tap **📲 Install app**
(Android) or Share → **Add to Home Screen** (iPhone).

There is nothing else to configure — no database, no environment variables, no
secrets. That's the whole point of the in-memory store.

---

## Two things to expect

**1. It sleeps.** Render's free plan idles the service after ~15 minutes with
nobody on it. The next person to open the link waits ~50 seconds for it to wake.

That costs more here than it did for DUKE$DEFENSE, because SKELLZ keeps room
state in the server's memory — **a sleep ends any match in progress** and drops
everyone back to the lobby. Between sessions it doesn't matter; mid-game it does.

To make it always-on, set **`KEEP_AWAKE=1`** in Render → your service →
**Environment**. It then pings itself every 10 minutes and never sleeps.

> ⚠️ **Only do this for ONE game.** Render gives your whole account 750 free
> instance-hours a month, and a service kept awake around the clock burns ~730
> of them by itself. DUKE$DEFENSE already pings itself 24/7 — switching this on
> as well would blow through the allowance and **suspend both games** before
> month end. Pick one, or move one to the $7/mo Starter plan.

**2. Don't scale it past one instance.** Rooms live in the memory of a single
process, so a second instance would have players routed to a server that has
never heard of their room. The free plan is always one instance, so this only
matters if you upgrade later. To scale out properly, move `src/server/store.ts`
to Redis or Postgres first.

---

## Updating the game later

```bash
git -C "D:/CLAUDE HACKS/hackingtool-plugin-main/skelzie/game" add -A
git -C "D:/CLAUDE HACKS/hackingtool-plugin-main/skelzie/game" commit -m "what changed"
git -C "D:/CLAUDE HACKS/hackingtool-plugin-main/skelzie/game" push
```

Render redeploys automatically within a minute or two. **The link never
changes**, and installed phones pick up the new version on next launch — the
service worker is set up so a new build always takes over immediately rather
than leaving anyone on a stale bundle.
