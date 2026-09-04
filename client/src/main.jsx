import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import './styles.css';

function Auth({ onLogin }) {
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function submit(event) { event.preventDefault(); try { const result = await api.login(identity, password); onLogin(result.user); } catch (e) { setError(e.message); } }
  return <main className="auth"><div className="brandMark">SC</div><p className="eyebrow">SOCIAL CIRCLE</p><h1>Find the places your people love.</h1><p className="muted">Recommendations, circles, and conversations in one calm space.</p><form onSubmit={submit}><label>Username or email<input value={identity} onChange={e => setIdentity(e.target.value)} required /></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>{error && <p className="error">{error}</p>}<button>Enter your circle</button></form></main>;
}
function App() {
  const [user, setUser] = useState(null); const [feed, setFeed] = useState([]); const [notice, setNotice] = useState('');
  useEffect(() => { api.me().then(result => setUser(result.user)).catch(() => {}); }, []);
  useEffect(() => { if (user) api.feed().then(result => setFeed(result.feed || [])); }, [user]);
  if (!user) return <Auth onLogin={setUser} />;
  return <div className="shell"><header><div><p className="eyebrow">YOUR CIRCLE</p><h1>Good morning, {user.displayName}.</h1></div><button className="quiet" onClick={() => api.logout().then(() => setUser(null))}>Log out</button></header><section className="welcome"><span>DISCOVER</span><h2>What is worth a visit today?</h2><p>See recommendations and notes from the people you trust.</p></section><nav><button className="selected">Home</button><button onClick={() => setNotice('Search and friend connections use the shared API.')}>Search</button><button onClick={() => setNotice('Circles, chat, and calls are ready for the next client slice.')}>Circles</button></nav>{notice && <p className="notice">{notice}</p>}<section className="feed"><div className="sectionTitle"><h2>Recent from your circle</h2><span>{feed.length} posts</span></div>{feed.length ? feed.map(post => <article key={post.id}><div className="avatar">{post.display_name?.[0] || '?'}</div><div><strong>{post.display_name}</strong><p>{post.content}</p><small>{new Date(post.created_at).toLocaleString()}</small></div></article>) : <div className="empty">Your circle is quiet for now. Your next recommendation will appear here.</div>}</section></div>;
}

createRoot(document.getElementById('root')).render(<App />);
