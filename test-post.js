const http = require('http');

const data = JSON.stringify({
  name: 'Test User',
  email: 'test' + Date.now() + '@example.com',
  password: 'password123',
  roles: ['Admin'],
  status: 'active'
});

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/users',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', body));
});

req.on('error', (e) => console.error(e));
req.write(data);
req.end();
