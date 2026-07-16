const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.users.findMany({
    include: {
      roles: {
        include: {
          role_permissions: {
            include: { permissions: true }
          }
        }
      },
      user_permissions: {
        include: { permissions: true }
      }
    }
  });
  
  const problemUser = users.find(u => {
    const allPerms = [
      ...(u.roles?.role_permissions?.map(rp => rp.permissions.key) || []),
      ...u.user_permissions.map(up => up.permissions.key)
    ];
    return allPerms.includes('hr.leave.self') && 
           !allPerms.includes('hr.view') && 
           (allPerms.some(p => p.startsWith('sales.')) || 
            allPerms.some(p => p.startsWith('development.')) || 
            allPerms.some(p => p.startsWith('project.')));
  });
  
  if (problemUser) {
    const allPerms = [
      ...(problemUser.roles?.role_permissions?.map(rp => rp.permissions.key) || []),
      ...problemUser.user_permissions.map(up => up.permissions.key)
    ];
    console.log("User:", problemUser.name, "Email:", problemUser.email);
    console.log("Role:", problemUser.roles?.name);
    console.log("Permissions:", allPerms);
  } else {
    console.log('Not found');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
