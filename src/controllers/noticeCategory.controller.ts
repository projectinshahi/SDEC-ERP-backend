import { Request, Response } from 'express';
import prisma from '../config/db.js';

/**
 * Notice Categories — the manageable source list for classifying notices.
 *
 * Mirrors the Project Category / Lead Stage lookup pattern, but notices reference
 * category_id (FK) rather than a denormalized name, so a rename needs no cascade.
 * The list is readable by any notice-viewer (to populate dropdowns/filters + the
 * dashboard); mutations are gated at the route by `notice.categories.manage`.
 * Adds two fields the other lookups lack — `color` (badge colour) and `icon`
 * (a lucide icon name) — plus a reorder endpoint (copied from lead stages).
 */

/** Trim + collapse whitespace; reject empty / over-long names. */
const validateName = (raw: unknown): { name: string } | { error: string } => {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Category name cannot be empty.' };
  if (name.length > 100) return { error: 'Category name must be 100 characters or fewer.' };
  return { name };
};

/** Normalise an optional hex colour; falls back to the default slate. */
const normalizeColor = (raw: unknown): string => {
  const c = String(raw ?? '').trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c) ? c : '#64748b';
};

/** GET /notices/categories — categories in display order (any notice viewer). */
export const getNoticeCategories = async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.notice_categories.findMany({
      orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }],
    });
    res.json(categories);
  } catch (error) {
    console.error('Error fetching notice categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /notices/categories — add a category (appended last). */
export const createNoticeCategory = async (req: Request, res: Response) => {
  try {
    const v = validateName(req.body?.name);
    if ('error' in v) return res.status(400).json({ error: v.error });

    const dup = await prisma.notice_categories.findFirst({
      where: { name: { equals: v.name, mode: 'insensitive' } },
    });
    if (dup) return res.status(409).json({ error: `A category named "${v.name}" already exists.` });

    const max = await prisma.notice_categories.aggregate({ _max: { orderIndex: true } });
    const orderIndex = (max._max.orderIndex ?? 0) + 1;

    const category = await prisma.notice_categories.create({
      data: {
        name: v.name,
        color: normalizeColor(req.body?.color),
        icon: req.body?.icon ? String(req.body.icon).slice(0, 50) : null,
        orderIndex,
        isActive: true,
      },
    });
    res.status(201).json(category);
  } catch (error) {
    console.error('Error creating notice category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /notices/categories/:id — rename / recolor / change icon / toggle active. */
export const updateNoticeCategory = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid category id' });

    const existing = await prisma.notice_categories.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    const data: { name?: string; color?: string; icon?: string | null; isActive?: boolean } = {};

    if (req.body?.name !== undefined) {
      const v = validateName(req.body.name);
      if ('error' in v) return res.status(400).json({ error: v.error });
      if (v.name.toLowerCase() !== existing.name.toLowerCase()) {
        const dup = await prisma.notice_categories.findFirst({
          where: { name: { equals: v.name, mode: 'insensitive' }, id: { not: id } },
        });
        if (dup) return res.status(409).json({ error: `A category named "${v.name}" already exists.` });
      }
      data.name = v.name;
    }
    if (req.body?.color !== undefined) data.color = normalizeColor(req.body.color);
    if (req.body?.icon !== undefined) data.icon = req.body.icon ? String(req.body.icon).slice(0, 50) : null;
    if (typeof req.body?.isActive === 'boolean') data.isActive = req.body.isActive;

    if (Object.keys(data).length === 0) return res.json(existing);
    const category = await prisma.notice_categories.update({ where: { id }, data });
    res.json(category);
  } catch (error) {
    console.error('Error updating notice category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /notices/categories/reorder — persist a new display order.
 * Body { orderedIds: number[] } must reference every category exactly once.
 */
export const reorderNoticeCategories = async (req: Request, res: Response) => {
  try {
    const orderedIds: unknown = req.body?.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.some((n) => typeof n !== 'number' || Number.isNaN(n))) {
      return res.status(400).json({ error: 'orderedIds must be an array of category ids.' });
    }
    const all = await prisma.notice_categories.findMany({ select: { id: true } });
    const ids = orderedIds as number[];
    const allSet = new Set(all.map((c) => c.id));
    if (ids.length !== all.length || new Set(ids).size !== ids.length || !ids.every((id) => allSet.has(id))) {
      return res.status(400).json({ error: 'orderedIds must reference every category exactly once.' });
    }
    await prisma.$transaction(ids.map((id, i) =>
      prisma.notice_categories.update({ where: { id }, data: { orderIndex: i + 1 } }),
    ));
    const categories = await prisma.notice_categories.findMany({ orderBy: { orderIndex: 'asc' } });
    res.json(categories);
  } catch (error) {
    console.error('Error reordering notice categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /notices/categories/:id — remove a category. Notices in it fall back to
 * Uncategorized (the FK is ON DELETE SET NULL), so no notice is lost.
 */
export const deleteNoticeCategory = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid category id' });
    const existing = await prisma.notice_categories.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    await prisma.notice_categories.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting notice category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
