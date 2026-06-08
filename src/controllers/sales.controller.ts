import { Request, Response } from 'express';
import prisma from '../config/db.js';

export const getLeads = async (req: Request, res: Response) => {
  try {
    const leads = await prisma.lead.findMany({
      include: {
        customer: true,
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(leads);
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createLead = async (req: Request, res: Response) => {
  try {
    const { title, description, source, status, priority, customerId } = req.body;
    const ownerId = (req as any).user?.id;

    if (!title || !ownerId) {
       return res.status(400).json({ error: 'Title and owner are required' });
    }

    const lead = await prisma.lead.create({
      data: {
        title,
        description,
        source,
        status: status || 'new',
        priority: priority || 'medium',
        customerId,
        ownerId,
      },
    });

    res.status(201).json(lead);
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getDeals = async (req: Request, res: Response) => {
  try {
    const deals = await prisma.deal.findMany({
      include: {
        customer: true,
        owner: { select: { id: true, name: true, email: true } },
        opportunity: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(deals);
  } catch (error) {
    console.error('Error fetching deals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createDeal = async (req: Request, res: Response) => {
  try {
    const { title, amount, status, customerId, opportunityId } = req.body;
    const ownerId = (req as any).user?.id;

    if (!title || !customerId || !ownerId) {
       return res.status(400).json({ error: 'Title, customer, and owner are required' });
    }

    const deal = await prisma.deal.create({
      data: {
        title,
        amount: Number(amount) || 0,
        status: status || 'won',
        customerId,
        opportunityId,
        ownerId,
      },
    });

    res.status(201).json(deal);
  } catch (error) {
    console.error('Error creating deal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getCustomers = async (req: Request, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      include: {
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(customers);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createCustomer = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, company, industry } = req.body;
    const ownerId = (req as any).user?.id;

    if (!name || !ownerId) {
       return res.status(400).json({ error: 'Name and owner are required' });
    }

    const customer = await prisma.customer.create({
      data: {
        name,
        email,
        phone,
        company,
        industry,
        ownerId,
      },
    });

    res.status(201).json(customer);
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
