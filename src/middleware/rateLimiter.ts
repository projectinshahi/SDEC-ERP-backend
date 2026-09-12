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
  /**
   * Bucket namespace. `store` is module-global, so WITHOUT a prefix every route
   * using this middleware shares one counter per IP — traffic to one endpoint
   * would eat another's budget. Give each route its own prefix.
   * Default '' preserves the original single-namespace behaviour.
   */
  keyPrefix?: string;
  /**
   * Derives the bucket identity. Defaults to the client IP.
   *
   * For AUTHENTICATED endpoints prefer the user id: app.ts sets no `trust proxy`,
   * so behind a reverse proxy (Render) `req.ip` is the PROXY's address and every
   * client would collapse into one shared bucket. Keying by user id also stops a
   * single account evading the limit by changing network.
   * Must run AFTER `authenticate` for req.userId to exist.
   */
  keyBy?: (req: Request) => string;
  /**
   * Emit X-RateLimit-* headers (default true). Set false on sensitive endpoints
   * where advertising the remaining budget helps an attacker pace their probing.
   */
  headers?: boolean;
}

/**
 * Returns Express middleware that rate-limits requests, by IP address by default.
 *
 * ```ts
 * // public, per-IP
 * router.post('/endpoint', rateLimiter({ windowMs: 60_000, max: 5 }), handler);
 *
 * // authenticated, per-user, own bucket
 * router.post('/endpoint', authenticate, rateLimiter({
 *   keyPrefix: 'my-route', keyBy: (req) => String((req as any).userId ?? req.ip),
 * }), handler);
 * ```
 */
export const rateLimiter = (opts: RateLimitOptions = {}) => {
  const windowMs = opts.windowMs ?? 15 * 60 * 1000; // 15 minutes
  const max = opts.max ?? 10;
  const message = opts.message ?? 'Too many requests. Please try again later.';
  const keyPrefix = opts.keyPrefix ?? '';
  const keyBy = opts.keyBy ?? ((req: Request) => req.ip || req.socket.remoteAddress || 'unknown');
  const sendHeaders = opts.headers ?? true;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Periodically prune (cheap — runs in O(n) but n is bounded by active keys)
    pruneStaleEntries();

    const key = `${keyPrefix}|${keyBy(req) || 'unknown'}`;
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(key, entry);
    } else {
      entry.count++;
    }

    // Set standard rate-limit headers
    if (sendHeaders) {
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    }

    if (entry.count > max) {
      res.status(429).json({ success: false, message });
      return;
    }

    next();
  };
};
