import { Request, Response } from 'express';
import {
  directMessageService,
  validateMessageBody,
  parseUserId,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
} from '../services/directMessage.service.js';

/**
 * Direct 1:1 messaging endpoints (Phase 2.6B), mounted at /api/messages.
 *
 * SENDER IDENTITY: every handler takes the sender from `req.userId`, which
 * authenticate() derived from the signed token. `req.body.senderId`,
 * `req.body.sender_id` and `?sender=` are never read anywhere in this file —
 * supplying them changes nothing.
 *
 * RECIPIENT AUTHORIZATION: a recipient must satisfy the existing visible-user
 * predicate. An invisible user and a non-existent user get the SAME 404 with the
 * same body, so this API cannot be used to discover which user ids exist.
 *
 * PRIVACY: no handler logs a message body. Errors are logged without content.
 */

/** The verified caller. authenticate() has already run on every route here. */
const uid = (req: Request): number => Number((req as any).userId);

/** One answer for "no such user" and "not visible to you" — see §6. */
const NOT_FOUND = { error: 'User not found' };

/** Never returns the raw row: read_at is exposed, nothing else is invented. */
const serialize = (m: {
  id: number; sender_id: number; recipient_id: number;
  message: string; created_at: Date; read_at: Date | null;
}) => ({
  id: m.id,
  senderId: m.sender_id,
  recipientId: m.recipient_id,
  message: m.message,
  createdAt: m.created_at,
  readAt: m.read_at,
});

/** GET /api/messages/threads */
export const getThreads = async (req: Request, res: Response) => {
  try {
    const threads = await directMessageService.threads(uid(req));
    return res.status(200).json(threads);
  } catch (error) {
    console.error('[Messages] Failed to list threads:', error);
    return res.status(500).json({ error: 'Failed to load conversations' });
  }
};

/** GET /api/messages/unread-count */
export const getUnreadCount = async (req: Request, res: Response) => {
  try {
    const count = await directMessageService.unreadCount(uid(req));
    return res.status(200).json({ count });
  } catch (error) {
    console.error('[Messages] Failed to count unread:', error);
    return res.status(500).json({ error: 'Failed to load unread count' });
  }
};

/** GET /api/messages/:userId — the conversation between the caller and :userId. */
export const getConversation = async (req: Request, res: Response) => {
  try {
    const me = uid(req);
    const otherId = parseUserId(req.params.userId);
    // A malformed id is answered exactly like an unknown one.
    if (otherId === null) return res.status(404).json(NOT_FOUND);
    if (otherId === me) return res.status(400).json({ error: 'You cannot message yourself' });

    // Visibility is checked BEFORE any message is read, so an unauthorized
    // caller never reaches the conversation query at all.
    const other = await directMessageService.findVisibleUser(otherId);
    if (!other) return res.status(404).json(NOT_FOUND);

    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_HISTORY_LIMIT)
      : DEFAULT_HISTORY_LIMIT;

    const messages = await directMessageService.conversation(me, otherId, limit);
    return res.status(200).json({ user: other, messages: messages.map(serialize) });
  } catch (error) {
    console.error('[Messages] Failed to load conversation:', error);
    return res.status(500).json({ error: 'Failed to load conversation' });
  }
};

/** POST /api/messages/:userId — body carries the content and nothing else that matters. */
export const sendMessage = async (req: Request, res: Response) => {
  try {
    const me = uid(req);
    const otherId = parseUserId(req.params.userId);
    if (otherId === null) return res.status(404).json(NOT_FOUND);
    if (otherId === me) return res.status(400).json({ error: 'You cannot message yourself' });

    if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'message is required' });
    }
    const validated = validateMessageBody((req.body as any).message);
    if (!validated.ok) return res.status(400).json({ error: validated.message });

    const other = await directMessageService.findVisibleUser(otherId);
    if (!other) return res.status(404).json(NOT_FOUND);

    // `me` — never req.body.senderId. That field is simply never read.
    const created = await directMessageService.send(me, otherId, validated.message);
    return res.status(201).json(serialize(created));
  } catch (error) {
    // The body is deliberately absent from this log line.
    console.error('[Messages] Failed to send message:', error);
    return res.status(500).json({ error: 'Failed to send message' });
  }
};

/** POST /api/messages/:userId/read — clears the caller's OWN unread from :userId. */
export const markConversationRead = async (req: Request, res: Response) => {
  try {
    const me = uid(req);
    const otherId = parseUserId(req.params.userId);
    if (otherId === null) return res.status(404).json(NOT_FOUND);
    if (otherId === me) return res.status(400).json({ error: 'You cannot message yourself' });

    const other = await directMessageService.findVisibleUser(otherId);
    if (!other) return res.status(404).json(NOT_FOUND);

    const updated = await directMessageService.markRead(me, otherId);
    return res.status(200).json({ success: true, updated });
  } catch (error) {
    console.error('[Messages] Failed to mark conversation read:', error);
    return res.status(500).json({ error: 'Failed to update read status' });
  }
};
