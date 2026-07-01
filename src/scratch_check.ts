import prisma from './config/db.js';

async function run() {
  const users = await prisma.$queryRawUnsafe('SELECT id, name, email, role FROM users');
  console.log('All Users:', JSON.stringify(users, null, 2));
  
  const employees = await prisma.$queryRawUnsafe('SELECT id, user_id, employee_code, department, designation FROM employees');
  console.log('All Employees:', JSON.stringify(employees, null, 2));

  const roles = await prisma.$queryRawUnsafe('SELECT id, name, permissions FROM roles');
  console.log('All Roles:', JSON.stringify(roles, null, 2));

  await prisma.$disconnect();
}

run().catch(console.error);
