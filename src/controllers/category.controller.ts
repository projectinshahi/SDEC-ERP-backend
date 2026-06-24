import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { isGlobalAdmin } from '../utils/roles.js';

/**
 * Project Categories — the manageable source list for classifying projects.
 *
 * Mirrors the Lead Stage module: `projects.category` stores the category NAME
 * (denormalized), so a rename cascades to every project in that category. The
 * list is readable by any authenticated user (to populate dropdowns/filters);
 * mutations are restricted to global admins (Admin / SuperAdmin).
 */

/** Trim + collapse whitespace; reject empty / over-long names. */
const validateCategoryName = (raw: unknown): { name: string } | { error: string } => {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Category name cannot be empty.' };
  if (name.length > 100) return { error: 'Category name must be 100 characters or fewer.' };
  return { name };
};

/** Guard: only Admin / SuperAdmin may mutate the category list. */
const requireAdmin = (req: Request, res: Response): boolean => {
  if (!isGlobalAdmin((req as any).userRole)) {
    res.status(403).json({ error: 'Only administrators can manage project categories.' });
    return false;
  }
  return true;
};

/** GET /project-categories — categories in display order (any authenticated user). */
export const getProjectCategories = async (_req: Request, res: Response) => {
  try {
    const categories = await prisma.project_categories.findMany({
      orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }],
    });
    res.json(categories);
  } catch (error) {
    console.error('Error fetching project categories:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /project-categories — add a category (admins only; appended last). */
export const createProjectCategory = async (req: Request, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;
    const v = validateCategoryName(req.body?.name);
    if ('error' in v) return res.status(400).json({ error: v.error });

    // Reject duplicates case-insensitively ("CRM" vs "crm").
    const dup = await prisma.project_categories.findFirst({
      where: { name: { equals: v.name, mode: 'insensitive' } },
    });
    if (dup) return res.status(409).json({ error: `A category named "${v.name}" already exists.` });

    const max = await prisma.project_categories.aggregate({ _max: { orderIndex: true } });
    const orderIndex = (max._max.orderIndex ?? 0) + 1;

    const category = await prisma.project_categories.create({
      data: { name: v.name, orderIndex, isActive: true },
    });
    res.status(201).json(category);
  } catch (error) {
    console.error('Error creating project category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * PUT /project-categories/:id — rename / toggle a category (admins only). Because
 * `projects.category` stores the NAME, a rename cascades to every project in that
 * category inside one transaction so no project is stranded on a vanished label.
 */
export const updateProjectCategory = async (req: Request, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid category id' });

    const existing = await prisma.project_categories.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    const data: { name?: string; isActive?: boolean } = {};

    if (req.body?.name !== undefined) {
      const v = validateCategoryName(req.body.name);
      if ('error' in v) return res.status(400).json({ error: v.error });
      if (v.name.toLowerCase() !== existing.name.toLowerCase()) {
        const dup = await prisma.project_categories.findFirst({
          where: { name: { equals: v.name, mode: 'insensitive' }, id: { not: id } },
        });
        if (dup) return res.status(409).json({ error: `A category named "${v.name}" already exists.` });
      }
      data.name = v.name;
    }
    if (typeof req.body?.isActive === 'boolean') data.isActive = req.body.isActive;

    if (Object.keys(data).length === 0) return res.json(existing);

    // Cascade the rename to projects when the name actually changes.
    if (data.name && data.name !== existing.name) {
      const [category] = await prisma.$transaction([
        prisma.project_categories.update({ where: { id }, data }),
        prisma.projects.updateMany({ where: { category: existing.name }, data: { category: data.name } }),
      ]);
      return res.json(category);
    }

    const category = await prisma.project_categories.update({ where: { id }, data });
    res.json(category);
  } catch (error) {
    console.error('Error updating project category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * DELETE /project-categories/:id — remove a category (admins only). Projects in
 * it are cleared to NULL (uncategorized) so no project is lost.
 */
export const deleteProjectCategory = async (req: Request, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid category id' });

    const existing = await prisma.project_categories.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    await prisma.$transaction([
      prisma.projects.updateMany({ where: { category: existing.name }, data: { category: null } }),
      prisma.project_categories.delete({ where: { id } }),
    ]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting project category:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
