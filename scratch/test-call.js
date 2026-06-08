const http = require('http');

const data = JSON.stringify({
  name: "Test User",
  phone: "+919354197715",
  preferred_slot: "12:00",
  call_type: "REVIEW_CALL",
  customer_value: "standard",
  urgency_level: "normal",
  preferred_language: "en",
  consent_status: "granted"
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/customers',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log(body));
});

req.on('error', e => console.error(e));
req.write(data);
req.end();
