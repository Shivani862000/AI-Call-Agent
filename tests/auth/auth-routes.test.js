const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const request = require('supertest');
const { createSessionMiddleware } = require('../../auth/session');
const { createAuthMiddleware, requireRole } = require('../../auth/middleware');
const { createAuthRouter } = require('../../routes/auth');

function setup({ secure = false } = {}) {
  const clients = [
    { id: 1, name: 'Client One', status: 'active' },
    { id: 2, name: 'Client Two', status: 'active' }
  ];
  const profiles = new Map([
    ['first', { id: 'user-1', username: 'first', email: 'first@example.com', active: true, auth_version: 1, roles: ['webmaster'] }],
    ['second', { id: 'user-2', username: 'second', email: 'second@example.com', active: true, auth_version: 1, roles: ['webmaster'] }]
  ]);
  const byId = () => new Map([...profiles.values()].map((profile) => [profile.id, profile]));
  const users = {
    async findByUsername(username) { return profiles.get(String(username).trim().toLowerCase()) || null; },
    async findAuthority(id) { return byId().get(id) || null; },
    async markLogin() {}
  };
  const clientRepository = {
    async listActive() { return clients.filter((client) => client.status === 'active'); },
    async findById(id) { return clients.find((client) => client.id === Number(id)) || null; }
  };
  const supabaseAuth = {
    async verifyPassword(email, password) {
      if (password !== `password-for-${email.split('@')[0]}`) return null;
      const profile = [...profiles.values()].find((candidate) => candidate.email === email);
      return profile ? { id: profile.id, accessToken: 'must-not-leak', refreshToken: 'must-not-leak' } : null;
    }
  };
  const auth = createAuthMiddleware({ users, clients: clientRepository });
  const app = express();
  if (secure) app.set('trust proxy', 1);
  app.use(express.json());
  app.use(createSessionMiddleware({ secret: 'test-cookie-secret-that-is-at-least-32-bytes', secure }));
  app.use('/auth', createAuthRouter({ supabaseAuth, users, clients: clientRepository, auth }));
  app.get('/protected', auth.reload, requireRole('webmaster'), (req, res) => res.json({ user: req.auth.username, clientId: req.activeClientId }));
  return { app, profiles, clients };
}

test('two webmasters log in independently and no Supabase token reaches the browser', async () => {
  const { app } = setup();
  for (const username of ['first', 'second']) {
    const agent = request.agent(app);
    const login = await agent.post('/auth/login').send({ username, password: `password-for-${username}` }).expect(200);
    assert.equal(login.body.user.username, username);
    assert.equal(JSON.stringify(login.body).includes('must-not-leak'), false);
    assert.match(login.headers['set-cookie'][0], /HttpOnly/i);
    assert.match(login.headers['set-cookie'][0], /SameSite=Strict/i);
    await agent.get('/protected').expect(200, { user: username, clientId: 1 });
  }
});

test('login failures are generic and production cookies are secure', async () => {
  const { app } = setup({ secure: true });
  const failure = await request(app).post('/auth/login').set('x-forwarded-proto', 'https').send({ username: 'first', password: 'wrong' }).expect(401);
  assert.deepEqual(failure.body, { error: 'Invalid username or password' });
  const success = await request(app).post('/auth/login').set('x-forwarded-proto', 'https').send({ username: 'first', password: 'password-for-first' }).expect(200);
  assert.match(success.headers['set-cookie'][0], /Secure/i);
  assert.equal(JSON.stringify(success.body).includes('token'), false);
});

test('sessions revalidate authority, support active-client selection, and clear on logout', async () => {
  const { app, profiles, clients } = setup();
  const agent = request.agent(app);
  await agent.post('/auth/login').send({ username: 'first', password: 'password-for-first' }).expect(200);
  await agent.post('/auth/select-client').send({ clientId: 2 }).expect(200);
  await agent.get('/protected').expect(200, { user: 'first', clientId: 2 });
  await agent.post('/auth/select-client').send({ clientId: 999 }).expect(400);
  clients[1].status = 'inactive';
  await agent.get('/protected').expect(401);

  const fresh = request.agent(app);
  clients[1].status = 'active';
  await fresh.post('/auth/login').send({ username: 'first', password: 'password-for-first' }).expect(200);
  profiles.get('first').auth_version = 2;
  await fresh.get('/protected').expect(401);

  profiles.get('first').auth_version = 1;
  const logout = request.agent(app);
  await logout.post('/auth/login').send({ username: 'first', password: 'password-for-first' }).expect(200);
  await logout.post('/auth/logout').expect(200);
  await logout.get('/protected').expect(401);
});

test('inactive and non-webmaster accounts cannot use protected routes', async () => {
  const { app, profiles } = setup();
  profiles.get('first').roles = [];
  const agent = request.agent(app);
  await agent.post('/auth/login').send({ username: 'first', password: 'password-for-first' }).expect(200);
  await agent.get('/protected').expect(403);
  profiles.get('first').active = false;
  await agent.get('/protected').expect(401);
});
