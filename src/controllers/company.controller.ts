import { Request, Response } from 'express';
import prisma from '../config/db.js';
import { getSalesAuth, ownerScopeFilter } from '../utils/salesAuth.js';

/**
 * Companies = normalized CRM accounts (globally deduped by case-insensitive name).
 * Company records are SHARED reference data, so the LIST is intentionally NOT
 * owner-scoped — any `sales.companies.view` holder sees the full account list. The
 * related Contacts + Pipeline on the detail page ARE owner-scoped (via ownerScopeFilter),
 * so per-owner data privacy is preserved even though the company itself is shared.
 */

const uid = (req: Request) => Number((req as any).userId);

/** Global dedup lookup — one company per case-insensitive name. */
function findCompanyByName(name: string) {
  return prisma.company.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
}

/** GET /sales/companies?q=&page=&pageSize= — list + optional search + pagination. */
export const getCompanies = async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const where: any = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { industry: { contains: q, mode: 'insensitive' } },
      ];
    }
    const [total, companies] = await Promise.all([
      prisma.company.count({ where }),
      prisma.company.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { contacts: true } } },
      }),
    ]);
    res.json({ data: companies, total, page, pageSize });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** GET /sales/companies/:id — a company with its (owner-scoped) contacts + pipeline. */
export const getCompanyById = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid company id' });
    const company = await prisma.company.findUnique({ where: { id } });
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const ctx = await getSalesAuth(req);
    const scope = await ownerScopeFilter(ctx);

    const contactWhere: any = { companyId: id };
    if (scope !== undefined) contactWhere.ownerId = scope;
    const contacts = await prisma.customer.findMany({
      where: contactWhere,
      select: {
        id: true, name: true, email: true, phone: true,
        designation: true, whatsapp: true, ownerId: true,
      },
      orderBy: { name: 'asc' },
    });

    // Related pipeline = opportunities linked DIRECTLY to this company (Lead.companyId,
    // Phase 2) OR via one of the company's contacts (Phase 1 back-compat). Deduped by id
    // by the OR query; scoped by the same owner filter.
    const contactIds = contacts.map((c) => c.id);
    const orClauses: any[] = [{ companyId: id }];
    if (contactIds.length) orClauses.push({ customerId: { in: contactIds } });
    const leadWhere: any = { OR: orClauses };
    if (scope !== undefined) leadWhere.ownerId = scope;
    const pipeline = await prisma.lead.findMany({
      where: leadWhere,
      select: { id: true, title: true, status: true, stage: true, temperature: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ ...company, contacts, pipeline });
  } catch (error) {
    console.error('Error fetching company:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /sales/companies */
export const createCompany = async (req: Request, res: Response) => {
  try {
    const ownerId = uid(req);
    const { name, industry, website, address, gst, notes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Company name is required' });
    const trimmed = String(name).trim();
    const existing = await findCompanyByName(trimmed);
    if (existing) return res.status(409).json({ error: 'A company with this name already exists', companyId: existing.id });
    const company = await prisma.company.create({
      data: {
        name: trimmed,
        industry: industry ?? null,
        website: website ?? null,
        address: address ?? null,
        gst: gst ?? null,
        notes: notes ?? null,
        ownerId: Number.isFinite(ownerId) ? ownerId : null,
      },
    });
    res.status(201).json(company);
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** PUT /sales/companies/:id */
export const updateCompany = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid company id' });
    const existing = await prisma.company.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Company not found' });

    const { name, industry, website, address, gst, notes } = req.body;
    const data: any = {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ error: 'Company name cannot be empty' });
      if (trimmed.toLowerCase() !== existing.name.toLowerCase()) {
        const dup = await findCompanyByName(trimmed);
        if (dup && dup.id !== id) return res.status(409).json({ error: 'A company with this name already exists' });
      }
      data.name = trimmed;
    }
    if (industry !== undefined) data.industry = industry ?? null;
    if (website !== undefined) data.website = website ?? null;
    if (address !== undefined) data.address = address ?? null;
    if (gst !== undefined) data.gst = gst ?? null;
    if (notes !== undefined) data.notes = notes ?? null;

    const company = await prisma.company.update({ where: { id }, data });
    res.json(company);
  } catch (error) {
    console.error('Error updating company:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** DELETE /sales/companies/:id — unlink contacts (companyId → null) then delete. */
export const deleteCompany = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid company id' });
    const existing = await prisma.company.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Company not found' });
    // Contacts survive; their companyId is cleared. Explicit in a tx so behaviour is
    // DB-independent (the FK is ON DELETE SET NULL, but this codebase does FK cleanup
    // in app code — see deleteLead/deleteDeal).
    await prisma.$transaction([
      prisma.customer.updateMany({ where: { companyId: id }, data: { companyId: null } }),
      prisma.company.delete({ where: { id } }),
    ]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting company:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
