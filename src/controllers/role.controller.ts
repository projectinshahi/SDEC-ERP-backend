import { Request, Response } from 'express';
import prisma from '../config/db';

export const createRole = async (req: Request, res: Response) => {
  try {
    const { name, description, permissions } = req.body as any;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Role name is required' });
    }

    if (!permissions || !Array.isArray(permissions) || permissions.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one permission must be selected' });
    }

    // Check if role exists
    const existingRoles = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM roles WHERE name = $1 LIMIT 1;',
      name
    );

    if (existingRoles.length > 0) {
      return res.status(400).json({ success: false, message: 'Role name already exists' });
    }

    const permissionsJson = JSON.stringify(permissions);

    // Insert role using raw SQL
    await prisma.$executeRawUnsafe(
      'INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3::jsonb);',
      name,
      description || '',
      permissionsJson
    );

    res.status(201).json({ success: true, message: 'Role created successfully' });
  } catch (error: any) {
    console.error('Error creating role:', error);
    res.status(500).json({ success: false, message: 'Failed to create role due to database or server error' });
  }
};

export const getRoles = async (req: Request, res: Response) => {
  try {
    const roles = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id, name, description, permissions, "createdAt" FROM roles ORDER BY id ASC;'
    );
    
    let users: any[] = [];
    try {
      users = await prisma.$queryRawUnsafe<any[]>(
        'SELECT role FROM users;'
      );
    } catch (userDbError) {
      console.warn('Could not query users table for count. Using 0.', userDbError);
    }

    const enrichedRoles = roles.map((role) => {
      let count = 0;
      if (users.length > 0 && role.name) {
        const targetRole = role.name.trim().toLowerCase();
        count = users.filter((u) => {
          if (!u.role) return false;
          // Split by comma in case user has multiple roles
          const userRoles = String(u.role)
            .split(',')
            .map((r) => r.trim().toLowerCase());
          return userRoles.includes(targetRole);
        }).length;
      }
      return {
        ...role,
        userCount: count,
      };
    });

    res.status(200).json(enrichedRoles);
  } catch (error) {
    console.error('Error fetching roles:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch roles' });
  }
};

export const updateRole = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, permissions } = req.body as any;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Role name is required' });
    }

    if (!permissions || !Array.isArray(permissions) || permissions.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one permission must be selected' });
    }

    // Check if role name exists on another role
    const existingRoles = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM roles WHERE name = $1 AND id != $2 LIMIT 1;',
      name,
      Number(id)
    );

    if (existingRoles.length > 0) {
      return res.status(400).json({ success: false, message: 'Role name already exists' });
    }

    const permissionsJson = JSON.stringify(permissions);

    // Update role using raw SQL
    await prisma.$executeRawUnsafe(
      'UPDATE roles SET name = $1, description = $2, permissions = $3::jsonb WHERE id = $4;',
      name,
      description || '',
      permissionsJson,
      Number(id)
    );

    res.status(200).json({ success: true, message: 'Role updated successfully' });
  } catch (error: any) {
    console.error('Error updating role:', error);
    res.status(500).json({ success: false, message: 'Failed to update role due to database or server error' });
  }
};

export const deleteRole = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if role exists
    const targetRoles = await prisma.$queryRawUnsafe<any[]>(
      'SELECT name FROM roles WHERE id = $1 LIMIT 1;',
      Number(id)
    );

    if (targetRoles.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    const roleName = targetRoles[0].name;

    // Step 1: Check if role is assigned to users
    let users: any[] = [];
    try {
      users = await prisma.$queryRawUnsafe<any[]>(
        'SELECT role, status FROM users;'
      );
    } catch (userDbError) {
      console.warn('Could not query users table for delete validation. Assuming 0.', userDbError);
    }

    let activeUsersCount = 0;
    if (users.length > 0 && roleName) {
      const targetRoleName = roleName.trim().toLowerCase();
      activeUsersCount = users.filter((u) => {
        if (!u.role) return false;
        // Split by comma in case user has multiple roles
        const userRoles = String(u.role)
          .split(',')
          .map((r) => r.trim().toLowerCase());
        const hasRole = userRoles.includes(targetRoleName);
        const isActive = !u.status || String(u.status).toLowerCase() === 'active';
        return hasRole && isActive;
      }).length;
    }

    // Step 2: Validation Logic
    if (activeUsersCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete role. It is assigned to active users.'
      });
    }

    // Proceed with deletion
    await prisma.$executeRawUnsafe(
      'DELETE FROM roles WHERE id = $1;',
      Number(id)
    );

    res.status(200).json({ message: 'Role deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting role:', error);
    res.status(500).json({ error: 'Failed to delete role due to database or server error' });
  }
};

