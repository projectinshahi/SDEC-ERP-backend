import prisma from '../config/db.js';
import { VISIBLE_USER_PREDICATE } from './userLookup.service.js';

/**
 * DIRECT 1:1 MESSAGING (Phase 2.6B).
 *
 * One table, `direct_messages`, one row per message. A "thread" is not stored —
 * it is derived from the (sender_id, recipient_id) pair, and read state is a
 * nullable column on the row.
 *
 * Two rules hold this feature together, and every function below obeys both:
 *
 *   1. The sender is ALWAYS the verified authenticated user. No function here
 *      accepts a sender from caller input — the controller passes req.userId,
 *      which authenticate() derived from the signed token.
 *   2. Every query is bounded by that user id. There is no code path that can
 *      return a row unless the authenticated user is its sender or recipient.
 *
 * Recipient visibility reuses VISIBLE_USER_PREDICATE — the SAME rule that
 * already decides which users appear in the picklist and in phone lookup. No
 * second user-visibility system.
 *
 * Self-check: npx tsx src/routes.directMessages.authz.selfcheck.ts
 */

/**
 * Max characters in one message. The column is TEXT, so this is a product/abuse
 * bound rather than a storage one — it keeps a single row from being used to
 * push megabytes through the API and into every client rendering the thread.
 */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Max messages returned for one conversation. The project has no cursor-pagination
 * convention (my-task chat returns its whole thread), so this is deliberately a
 * simple safety bound, not a pagination scheme: the most recent N, returned in
 * chronological order for direct client consumption.
 */
export const DEFAULT_HISTORY_LIMIT = 200;
export const MAX_HISTORY_LIMIT = 500;

export interface DirectMessageRow {
  id: number;
  sender_id: number;
  recipient_id: number;
  message: string;
  created_at: Date;
  read_at: Date | null;
}

export interface ThreadSummary {
  user: { id: number; name: string; email: string; role: string | null };
  lastMessage: string;
  lastMessageAt: Date;
  lastMessageSenderId: number;
  unreadCount: number;
}

export type ValidationResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/**
 * Validate a message body. Rejections are 400s and never echo the content back —
 * a private message must not end up in a client log or an error tracker.
 */
export function validateMessageBody(input: unknown): ValidationResult {
  if (input === undefined || input === null) {
    return { ok: false, message: 'message is required' };
  }
  if (typeof input !== 'string') {
    return { ok: false, message: 'message must be a string' };
  }
  // Trim for the emptiness test AND for storage: a whitespace-only message is
  // not a message, and trailing whitespace is never meaningful here.
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'message must not be empty' };
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, message: `message must be at most ${MAX_MESSAGE_LENGTH} characters` };
  }
  return { ok: true, message: trimmed };
}

/** Parse a user id from a route param. Rejects anything that is not a positive int4. */
export function parseUserId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) return null;
  return n;
}

export const directMessageService = {
  /**
   * The other half of the authorization boundary: is `userId` a user the caller
   * is allowed to see at all?
   *
   * Returns the visible user or null. The caller turns null into a 404 — the
   * SAME answer given for a user id that does not exist — so this endpoint can
   * never be used to enumerate which ids are real.
   */
  async findVisibleUser(userId: number): Promise<{ id: number; name: string; email: string; role: string | null } | null> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, name, email, role FROM users
        WHERE id = $1 AND ${VISIBLE_USER_PREDICATE}
        LIMIT 1;`,
      userId,
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    // Explicit allow-list — never spread the row, that is how password hashes and
    // reset tokens leak into a response.
    return { id: r.id, name: r.name, email: r.email, role: r.role ?? null };
  },

  /** Store a message. `senderId` is the verified identity and is never caller-supplied. */
  async send(senderId: number, recipientId: number, message: string): Promise<DirectMessageRow> {
    const rows = await prisma.$queryRawUnsafe<DirectMessageRow[]>(
      `INSERT INTO direct_messages (sender_id, recipient_id, message)
       VALUES ($1, $2, $3)
       RETURNING id, sender_id, recipient_id, message, created_at, read_at;`,
      senderId,
      recipientId,
      message,
    );
    return rows[0];
  },

  /**
   * The conversation between exactly these two users, oldest → newest.
   *
   * The WHERE pins BOTH directions of the SAME pair, so a row involving any
   * third user cannot match: it is not "messages from A" filtered afterwards.
   * The subquery takes the most recent `limit` rows, then the outer query puts
   * them back in chronological order.
   */
  async conversation(userA: number, userB: number, limit: number): Promise<DirectMessageRow[]> {
    return prisma.$queryRawUnsafe<DirectMessageRow[]>(
      `SELECT id, sender_id, recipient_id, message, created_at, read_at FROM (
         SELECT id, sender_id, recipient_id, message, created_at, read_at
           FROM direct_messages
          WHERE (sender_id = $1 AND recipient_id = $2)
             OR (sender_id = $2 AND recipient_id = $1)
          ORDER BY created_at DESC, id DESC
          LIMIT $3
       ) recent
       ORDER BY created_at ASC, id ASC;`,
      userA,
      userB,
      limit,
    );
  },

  /**
   * Mark as read the messages `otherUserId` sent to `userId`.
   *
   * The WHERE makes the authenticated user the RECIPIENT, so a caller can only
   * ever clear their own inbox — never someone else's, and never the messages
   * they themselves sent. Already-read rows are left alone so the original
   * timestamp survives.
   */
  async markRead(userId: number, otherUserId: number): Promise<number> {
    const result = await prisma.$executeRawUnsafe(
      `UPDATE direct_messages
          SET read_at = now()
        WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL;`,
      userId,
      otherUserId,
    );
    return Number(result);
  },

  /** Unread messages addressed TO this user. Never counts anyone else's inbox. */
  async unreadCount(userId: number): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
      `SELECT COUNT(*)::int AS count FROM direct_messages
        WHERE recipient_id = $1 AND read_at IS NULL;`,
      userId,
    );
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Every conversation this user is part of, newest first.
   *
   * ONE query, no N+1: DISTINCT ON collapses each partner to their latest
   * message, a single grouped scan supplies the unread counts, and the partner's
   * name/role is joined in — and gated by VISIBLE_USER_PREDICATE, so a partner
   * who has since been deactivated drops out of the list rather than leaking.
   */
  async threads(userId: number): Promise<ThreadSummary[]> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `WITH latest AS (
         SELECT DISTINCT ON (CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END)
                CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_id,
                message, created_at, sender_id
           FROM direct_messages
          WHERE sender_id = $1 OR recipient_id = $1
          ORDER BY CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END,
                   created_at DESC, id DESC
       ),
       unread AS (
         SELECT sender_id AS other_id, COUNT(*)::int AS unread_count
           FROM direct_messages
          WHERE recipient_id = $1 AND read_at IS NULL
          GROUP BY sender_id
       )
       SELECT l.other_id, l.message, l.created_at, l.sender_id,
              COALESCE(u.unread_count, 0) AS unread_count,
              usr.name, usr.email, usr.role
         FROM latest l
         JOIN users usr ON usr.id = l.other_id AND ${VISIBLE_USER_PREDICATE}
         LEFT JOIN unread u ON u.other_id = l.other_id
        ORDER BY l.created_at DESC;`,
      userId,
    );

    return rows.map((r) => ({
      user: { id: r.other_id, name: r.name, email: r.email, role: r.role ?? null },
      lastMessage: r.message,
      lastMessageAt: r.created_at,
      lastMessageSenderId: r.sender_id,
      unreadCount: Number(r.unread_count ?? 0),
    }));
  },
};
