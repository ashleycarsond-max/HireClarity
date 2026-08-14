/**
 * Access-gating flag (server-only, pure).
 *
 * EARLY_ACCESS_FREE=1 (or unset) keeps /check and /company open to everyone —
 * that is the default and the current live behavior. Set EARLY_ACCESS_FREE=0
 * to turn the subscription gate on.
 */

export function earlyAccessFree(): boolean {
  return process.env.EARLY_ACCESS_FREE !== "0";
}
