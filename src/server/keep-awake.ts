/**
 * KEEP-AWAKE
 *
 * Free hosts (Render's free plan and friends) put a service to sleep after
 * ~15 minutes with no inbound traffic, so the next player to open the link
 * waits out a cold start. Pinging our own public URL every 10 minutes counts
 * as inbound traffic and resets that idle timer, so the link stays instant.
 *
 * It matters more here than on most sites: room state lives in this process's
 * memory, so a sleep does not just cost a slow load — it drops any match that
 * was in progress.
 *
 * OFF BY DEFAULT, deliberately. Render's free tier gives one account 750
 * instance-hours a month, and a service kept awake around the clock burns
 * ~730 of them on its own. Turning this on for two free services at once will
 * exhaust the allowance and suspend BOTH of them before the month is out. Set
 * KEEP_AWAKE=1 on whichever single game you want always-on.
 *
 * Render injects RENDER_EXTERNAL_URL. Anywhere else, set SELF_URL to the
 * public https address.
 */

const PING_EVERY_MS = 10 * 60 * 1000;

let started = false;

export function startKeepAwake() {
  if (started) return;

  const enabled = /^(1|true|yes|on)$/i.test(process.env.KEEP_AWAKE ?? "");
  if (!enabled) return;

  const url = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "").replace(/\/+$/, "");
  if (!url) {
    console.log("[keep-awake] KEEP_AWAKE is set but no RENDER_EXTERNAL_URL/SELF_URL — skipping.");
    return;
  }

  started = true;
  console.log(`[keep-awake] pinging ${url}/api/health every 10 min so the service never sleeps.`);

  const timer = setInterval(() => {
    // An inbound hit is all it takes; the response is irrelevant.
    fetch(`${url}/api/health`).catch(() => undefined);
  }, PING_EVERY_MS);

  // Never hold the process open on its own account.
  timer.unref?.();
}
