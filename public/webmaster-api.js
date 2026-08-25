export async function request(path, options = {}) {
  const response = await fetch(`/api/webmaster${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  if (response.status === 401) location.assign('/login.html');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || 'Request failed'), payload, { status: response.status });
  return payload;
}
export const api = { get: path => request(path), post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }), patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }), put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }) };
