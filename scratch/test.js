const http = require('http');

const data = JSON.stringify({
  name: 'Test Patient',
  phone: '+919999999999',
  preferred_slot: '22:30',
  scheduled_date: '2026-06-16',
  call_type: 'REVIEW_CALL'
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/customers',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', (d) => {
    process.stdout.write(d);
  });
});

req.on('error', (error) => {
  console.error(error);
});

req.write(data);
req.end();
