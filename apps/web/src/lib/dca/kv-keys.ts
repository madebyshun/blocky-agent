/**
 * KV key layout for DCA schedules.
 *
 *   dca:schedule:<id>                — DcaSchedule JSON
 *   dca:user:<addr>:schedules        — string[] of schedule IDs owned by user
 *   dca:active                       — string[] of active schedule IDs (cron work queue)
 *   dca:lock:<id>                    — NX lock during a single execution (TTL = frequency-ish)
 *   dca:logs:<id>                    — DcaExecutionLog[] ring buffer (last 50 runs)
 *
 * Rationale for `active` being a single flat array rather than per-frequency:
 * v1 runs ~50 schedules max, cron sweeps all of them each tick, cheap. When
 * we exceed a few thousand active schedules we'll shard by frequency bucket.
 */

export const dcaKeys = {
  schedule:  (id: string) => `dca:schedule:${id}`,
  userIndex: (address: string) => `dca:user:${address.toLowerCase()}:schedules`,
  activeSet: () => `dca:active`,
  execLock:  (id: string) => `dca:lock:${id}`,
  logs:      (id: string) => `dca:logs:${id}`,
} as const;

/** How many execution logs to retain per schedule. */
export const DCA_LOG_MAX = 50;

/**
 * Cron lock TTL (seconds). Longer than the worst-case execution time so a
 * stuck run doesn't get double-fired, but shorter than the schedule's own
 * frequency so a legitimate next run is never blocked.
 */
export const DCA_LOCK_TTL_SEC = 120;
