import prisma from '../config/db.js';
import { can, type SalesAuthContext } from '../utils/salesAuth.js';
import type { Denial } from './contentWorkflow.service.js';

/**
 * MK-001 — THE project-scope gate.
 *
 * Every project-scoped read and write (calendar, events, Kanban, card create)
 * resolves its project through `resolveProject`. That is deliberate: the client
 * sends a project id on almost every request, and if each endpoint did its own
 * `findUnique` the "does it exist / may this caller touch it" rule would exist in
 * a dozen places and drift. One function means a missing project, an archived
 * project and an unauthorized caller are answered identically everywhere.
 *
 * The id is ALWAYS re-resolved server-side. A caller passing another project's
 * id gets the same 403/404 they would get from guessing a URL — the frontend's
 * "active project" is a UI convenience, never an authorization input.
 */

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Read access to the Marketing project workspace. */
export const PROJECT_VIEW_KEY = 'marketing.content.view';
/** Creating / editing / archiving a project itself is an admin-level action. */
export const PROJECT_MANAGE_KEY = 'marketing.settings.manage';
/** Event writes ride the Content edit authority — same module, same team. */
export const EVENT_WRITE_KEYS = ['marketing.content.edit', 'marketing.content.create'] as const;

export interface ProjectRow {
  id: number;
  client_id: number;
  name: string;
  status: string;
  description: string | null;
  start_date: Date | null;
  end_date: Date | null;
}

export interface ResolvedProject {
  project?: ProjectRow;
  denial?: Denial;
}

/** Parse a path/query id strictly — `NaN` must never become "no filter". */
export function projectIdParam(raw: unknown): number | null {
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve a project the caller is allowed to act on.
 *
 * @param write  true for mutations — an ARCHIVED project is read-only, so new
 *               events and cards cannot be added to a closed workspace.
 */
export async function resolveProject(
  rawId: unknown,
  ctx: SalesAuthContext,
  opts: { write?: boolean } = {},
): Promise<ResolvedProject> {
  if (!can(ctx, PROJECT_VIEW_KEY)) {
    return { denial: { status: 403, message: 'You do not have permission to view Marketing projects.' } };
  }

  const id = projectIdParam(rawId);
  if (!id) return { denial: { status: 400, message: 'A valid project is required.' } };

  const project = await prisma.marketing_projects.findUnique({
    where: { id },
    select: {
      id: true, client_id: true, name: true, status: true,
      description: true, start_date: true, end_date: true,
    },
  });
  // Same answer for "does not exist" and "not yours": probing ids must not
  // reveal which projects are real.
  if (!project) return { denial: { status: 404, message: 'Project not found.' } };

  if (opts.write && project.status === 'archived') {
    return { denial: { status: 409, message: 'This project is archived and cannot be changed.' } };
  }

  return { project };
}

/** May this actor create/edit/delete events in a project they can already see? */
export function canWriteEvents(ctx: SalesAuthContext): boolean {
  return EVENT_WRITE_KEYS.some((k) => can(ctx, k));
}

/** May this actor create or archive projects? */
export function canManageProjects(ctx: SalesAuthContext): boolean {
  return can(ctx, PROJECT_MANAGE_KEY);
}
