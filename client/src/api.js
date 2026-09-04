const request = async (url, options = {}) => {
  const response = await fetch(`/api${url}`, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error?.message || 'Request failed');
  return body.data || body;
};

export const api = {
  me: () => request('/auth/me'),
  login: (identity, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ identity, password }) }),
  signup: (data) => request('/auth/signup', { method: 'POST', body: JSON.stringify(data) }),
  feed: () => request('/feed'),
  notifications: () => request('/notifications'),
  searchUsers: (q) => request(`/users/search?q=${encodeURIComponent(q)}`),
  connections: () => request('/connections/requests'),
  logout: () => request('/auth/logout', { method: 'POST' })
};
