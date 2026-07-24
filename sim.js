import fs from 'fs';
const rolesStr = fs.readFileSync('C:/Users/Dell/.gemini/antigravity-ide/brain/97b708bb-19df-4859-9373-cb6765ae98df/.system_generated/steps/1189/output.txt', 'utf8');
const roles = JSON.parse(rolesStr);
const users = [
  {id:3, email:'admin@gmail.com', role:'admin, Admin'},
  {id:18, email:'arjungangadharan505@gmail.com', role:'BDE'},
  {id:27, email:'marshookali98@gmail.com', role:'Developer'},
  {id:11, email:'jaseempeter7@gmail.com', role:'Admin, Sales Head'},
  {id:5, email:'nived050@gmail.com', role:'Project Manager'},
  {id:31, email:'adarshak.eng@gmail.com', role:'HR/CEO'},
  {id:15, email:'founder@sdec.local', role:'SuperAdmin'},
  {id:49, email:'founder@gmail.com', role:'Super Admin'},
  {id:59, email:'rshahi.eng@gmail.com', role:'Director'},
  {id:13, email:'hrithikelayur12@gmail.com', role:'Developer'},
  {id:32, email:'fayasrahman3504@gmail.com', role:'Media Production Head'},
  {id:111, email:'hrfaculty26@gmail.com', role:'HR Admin'},
  {id:120, email:'hrsahahisolutions@gmail.com', role:'HR Admin'},
  // some others that might not be in my short list...
  {id:22, email:'abhishekjith6@gmail.com', role:'BDE'},
  {id:28, email:'shareefnncr@gmail.com', role:'Developer'}
];

const SIDEBAR_ITEMS = [
  { module: 'dashboard', permission: 'dashboard.view' },
  { module: 'project', permission: 'project.view' },
  { module: 'sales', permission: ['sales.dashboard.view'] },
  { module: 'sales', permission: ['sales.leads.view'] },
  { module: 'hr', permission: ['hr.dashboard.view', 'hr.view'] },
  { module: 'finance', permission: ['finance.dashboard.view', 'finance.view'] },
];

for(const u of users) {
  const rName = u.role.split(',')[0].trim();
  const rData = roles.find(r => r.name.toLowerCase() === rName.toLowerCase());
  const p = rData ? rData.permissions : [];
  
  const hasSales = p.some(x=>x.startsWith('sales.'));
  const hasDev = p.some(x=>x.startsWith('project.')||x.startsWith('dashboard.'));
  const hasHR = p.some(x=>x.startsWith('hr.'));
  const hasFin = p.some(x=>x.startsWith('finance.'));
  
  let salesHref = hasSales ? SIDEBAR_ITEMS.filter(i=>i.module==='sales').some(i=> i.permission.some(req => p.includes(req) || (req.endsWith('.view') && p.includes(req.replace(/\.[^.]+$/, ''))))) : false;
  
  if (hasSales && !salesHref) {
    console.log("BUG FOUND FOR USER:", u.email, "Role:", u.role, "RoleName:", rName);
  }
}
