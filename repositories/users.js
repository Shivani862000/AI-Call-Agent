function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    active: Boolean(row.active),
    auth_version: Number(row.auth_version),
    last_login_at: row.last_login_at instanceof Date ? row.last_login_at.toISOString() : row.last_login_at,
    roles: Array.isArray(row.roles) ? row.roles : []
  };
}

function createUsersRepository(database) {
  if (!database || typeof database.query !== 'function') throw new TypeError('Users repository requires a database query function');
  return {
    async findByUsername(username) {
      const result = await database.query(
        `select u.*, coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
           from app_users u left join app_user_roles r on r.user_id = u.id
          where u.username_normalized = $1 group by u.id`,
        [normalize(username)]
      );
      return mapUser(result.rows[0]);
    },
    async findAuthority(id) {
      const result = await database.query(
        `select u.*, coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
           from app_users u left join app_user_roles r on r.user_id = u.id
          where u.id = $1 group by u.id`,
        [id]
      );
      return mapUser(result.rows[0]);
    },
    async markLogin(id) {
      await database.query('update app_users set last_login_at = now(), updated_at = now() where id = $1', [id]);
    }
  };
}

module.exports = { createUsersRepository, normalize };
