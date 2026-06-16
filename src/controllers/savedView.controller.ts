import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, isManager } from '../utils/salesAuth.js';

/**
 * SE-020.1 — Saved Pipeline Filter Views.
 *
 * A saved view is a named bundle of pipeline filters with a visibility scope:
 *   • personal — only the owner sees it
 *   • team     — every sales user sees it (manager/admin can publish)
 *   • global   — admin-curated, visible to all (admin only)
 */

const VALID_ENTITIES = ['deal', 'lead'];
const VALID_SCOPES = ['personal', 'team', 'global'];

const viewSelect = {
  id: true,
  name: true,
  entity: true,
  scope: true,
  filters: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true } },
} as const;

/** GET /sales/views?entity=deal — views visible to the current user. */
export const getSavedViews = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const entity = typeof req.query.entity === 'string' ? req.query.entity : undefined;

    const where: any = {
      OR: [
        { ownerId: ctx.userId }, // personal (own)
        { scope: 'team' },
        { scope: 'global' },
      ],
    };
    if (entity && VALID_ENTITIES.includes(entity)) where.entity = entity;

    const views = await prisma.savedView.findMany({
      where,
      select: viewSelect,
      orderBy: [{ scope: 'asc' }, { name: 'asc' }],
    });
    res.json(views);
  } catch (error) {
    console.error('Error fetching saved views:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/views — create a saved view. Team/global scope requires elevation. */
export const createSavedView = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'A view name is required.' });

    const entity = VALID_ENTITIES.includes(req.body.entity) ? req.body.entity : 'deal';
    const scope = VALID_SCOPES.includes(req.body.scope) ? req.body.scope : 'personal';
    const filters = req.body.filters && typeof req.body.filters === 'object' ? req.body.filters : {};

    // Scope gating: only managers can publish team views; only admins global.
    if (scope === 'global' && !ctx.isAdmin) {
      return res.status(403).json({ error: 'Only admins can create global views.' });
    }
    if (scope === 'team' && !isManager(ctx)) {
      return res.status(403).json({ error: 'Only managers can create team views.' });
    }

    const view = await prisma.savedView.create({
      data: { name, entity, scope, filters, ownerId: ctx.userId },
      select: viewSelect,
    });
    res.status(201).json(view);
  } catch (error) {
    console.error('Error creating saved view:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/views/:id — update name/scope/filters. Owner or admin only. */
export const updateSavedView = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid view id' });

    const existing = await prisma.savedView.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'View not found' });
    if (existing.ownerId !== ctx.userId && !ctx.isAdmin) {
      return res.status(403).json({ error: 'You can only edit your own views.' });
    }

    const data: Record<string, any> = {};
    if (typeof req.body.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
    if (req.body.filters && typeof req.body.filters === 'object') data.filters = req.body.filters;
    if (req.body.scope && VALID_SCOPES.includes(req.body.scope)) {
      if (req.body.scope === 'global' && !ctx.isAdmin) {
        return res.status(403).json({ error: 'Only admins can publish global views.' });
      }
      if (req.body.scope === 'team' && !isManager(ctx)) {
        return res.status(403).json({ error: 'Only managers can publish team views.' });
      }
      data.scope = req.body.scope;
    }

    const view = await prisma.savedView.update({ where: { id }, data, select: viewSelect });
    res.json(view);
  } catch (error) {
    console.error('Error updating saved view:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/views/:id — owner or admin only. */
export const deleteSavedView = async (req: Request, res: Response) => {
  try {
    const ctx = await getSalesAuth(req);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid view id' });

    const existing = await prisma.savedView.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'View not found' });
    if (existing.ownerId !== ctx.userId && !ctx.isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own views.' });
    }

    await prisma.savedView.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting saved view:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
