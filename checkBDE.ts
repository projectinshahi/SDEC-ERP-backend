import prisma from './src/config/db.js';

async function run() {
  const r = await prisma.roles.findFirst({ where: { name: 'BDE' } });
  console.log('BDE role:');
  console.log(r?.permissions);

  const admin = await prisma.roles.findFirst({ where: { name: 'admin' } });
  console.log('admin role:');
  console.log(admin?.permissions.slice(0, 10)); // just a peek
}
run().finally(() => prisma.$disconnect());
