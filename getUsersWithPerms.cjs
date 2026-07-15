const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const users = await prisma.users.findMany({
    include: {
      role_mapping: {
        include: {
          roles: {
            include: {
              role_permissions: {
                include: {
                  permissions: true
                }
              }
            }
          }
        }
      }
    }
  });

  const formatted = users.map(u => {
    const perms = u.role_mapping?.roles?.role_permissions?.map(rp => rp.permissions.name) || [];
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      roleName: u.role_mapping?.roles?.name,
      permissions: perms,
    };
  });
  
  console.log(JSON.stringify(formatted, null, 2));
}

run().finally(() => prisma.$disconnect());
