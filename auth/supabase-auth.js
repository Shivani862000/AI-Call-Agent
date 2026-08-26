const { createClient } = require('@supabase/supabase-js');

function clientOptions() {
  return { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
}

function createSupabaseAuth({ url, anonKey }) {
  if (!url || !anonKey) throw new Error('Supabase URL and publishable key are required');
  const client = createClient(url, anonKey, clientOptions());
  return {
    async verifyPassword(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error || !data?.user) return null;
      return { id: data.user.id };
    }
  };
}

function createSupabaseAdmin({ url, serviceRoleKey }) {
  if (!url || !serviceRoleKey) throw new Error('Supabase URL and secret key are required');
  const client = createClient(url, serviceRoleKey, clientOptions());
  return {
    async createUser({ email, password }) {
      const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      return { id: data.user.id };
    },
    async deleteUser(id) {
      const { error } = await client.auth.admin.deleteUser(id);
      if (error) throw error;
    }
  };
}

module.exports = { createSupabaseAdmin, createSupabaseAuth };
