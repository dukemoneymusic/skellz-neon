/**
 * Runs once when the server boots. Next calls this automatically.
 */
export async function register() {
  // Skip the edge runtime — there is no long-lived process there to keep awake.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startKeepAwake } = await import("./server/keep-awake");
  startKeepAwake();
}
