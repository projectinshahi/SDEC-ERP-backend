import prisma from './src/config/db.js';

async function run() {
  const users = await prisma.users.findMany();
  for (const u of users) {
    const roleName = u.role ? String(u.role).split(',')[0].trim() : 'User';
    let permissions = [];
    let roleRows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT permissions FROM roles WHERE name = $1 LIMIT 1;',
      roleName
    );
    if (roleRows.length === 0) {
      roleRows = await prisma.$queryRawUnsafe<any[]>(
        'SELECT permissions FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1;',
        roleName
      );
    }
    if (roleRows.length > 0 && roleRows[0].permissions) {
      const raw = roleRows[0].permissions;
      permissions = Array.isArray(raw) ? raw : JSON.parse(raw);
    }
    console.log(`User: ${u.email} | RoleString: ${u.role} | RoleName: ${roleName}`);
    console.log(`Has Sales? ${permissions.some(p => p.startsWith('sales.'))}`);
    console.log(`Has Dev? ${permissions.some(p => p.startsWith('project.') || p.startsWith('dashboard.'))}`);
    console.log(`Has HR? ${permissions.some(p => p.startsWith('hr.'))}`);
    console.log(`Has Finance? ${permissions.some(p => p.startsWith('finance.'))}`);
    console.log('---');
  }
}
run().finally(() => prisma.$disconnect());
