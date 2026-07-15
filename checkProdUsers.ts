import prisma from './src/config/db.js';

async function run() {
  const users = await prisma.users.findMany();
  for (const u of users) {
    if (u.status !== 'active') continue;
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
    
    // Check module visibility based on moduleAccess.ts logic
    const hasSales = permissions.some(p => p.startsWith('sales.'));
    const hasDev = permissions.some(p => p.startsWith('project.') || p.startsWith('dashboard.') || p.startsWith('task.') || p.startsWith('bugs.'));
    const hasHR = permissions.some(p => p.startsWith('hr.'));
    const hasFinance = permissions.some(p => p.startsWith('finance.'));
    const isSuperAdmin = roleName.toLowerCase() === 'admin' || roleName.toLowerCase() === 'superadmin' || roleName.toLowerCase() === 'super admin';
    
    if (isSuperAdmin) continue; // They can access everything
    
    // Now check if they are missing the dashboard views for visible modules
    const missesSalesDash = hasSales && !permissions.includes('sales.dashboard.view') && !permissions.includes('sales.view');
    const missesDevDash = hasDev && !permissions.includes('dashboard.view');
    const missesHRDash = hasHR && !permissions.includes('hr.dashboard.view') && !permissions.includes('hr.view');
    const missesFinanceDash = hasFinance && !permissions.includes('finance.dashboard.view') && !permissions.includes('finance.view');
    
    if (missesSalesDash || missesDevDash || missesFinanceDash) {
      console.log(`\nUser: ${u.email} | Role: ${u.role}`);
      console.log(`Visible Modules -> Sales:${hasSales} Dev:${hasDev} HR:${hasHR} Finance:${hasFinance}`);
      console.log(`Missing Dash -> Sales:${missesSalesDash} Dev:${missesDevDash} HR:${missesHRDash} Finance:${missesFinanceDash}`);
    }
  }
}
run().finally(() => prisma.$disconnect());
