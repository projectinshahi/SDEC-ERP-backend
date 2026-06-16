import { Request, Response, NextFunction } from 'express';

/**
 * Lightweight in-memory sliding-window rate limiter.
 *
 * Tracks request counts per IP address within a configurable time window.
 * Stale entries are automatically cleaned up on every request to prevent
 * unbounded memory growth.
 *
 * For multi-instance deployments this should be replaced with a Redis-backed
 * implementation; for a single-server setup this is more than adequate.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms
}

const store = new Map<string, RateLimitEntry>();

/** Remove entries whose window has already expired. */
function pruneStaleEntries(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) store.delete(key);
  }
}

export interface RateLimitOptions {
  /** Time window in milliseconds (default: 15 minutes). */
  windowMs?: number;
  /** Maximum number of requests allowed in each window (default: 10). */
  max?: number;
  /** Custom message returned when limit is exceeded. */
  message?: string;
}

/**
 * Returns Express middleware that rate-limits requests by IP address.
 *
 * ```ts
 * router.post('/endpoint', rateLimiter({ windowMs: 60_000, max: 5 }), handler);
 * ```
 */
export const rateLimiter = (opts: RateLimitOptions = {}) => {
  const windowMs = opts.windowMs ?? 15 * 60 * 1000; // 15 minutes
  const max = opts.max ?? 10;
  const message = opts.message ?? 'Too many requests. Please try again later.';

  return (req: Request, res: Response, next: NextFunction): void => {
    // Periodically prune (cheap — runs in O(n) but n is bounded by active IPs)
    pruneStaleEntries();

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = store.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(ip, entry);
    } else {
      entry.count++;
    }

    // Set standard rate-limit headers
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      res.status(429).json({ success: false, message });
      return;
    }

    next();
  };
};
