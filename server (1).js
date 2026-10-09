'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- JWT secret (env yoki data/secret.key faylida saqlanadi) ---------- */
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const JWT_SECRET = loadSecret();

/* ---------- Database ---------- */
const db = new Database(path.join(DATA_DIR, 'videogram.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_recv ON messages(receiver_id, read);
`);

/* ---------- Upload (rasm va video) ---------- */
const ALLOWED = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
};
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString('hex') + ALLOWED[file.mimetype])
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    ALLOWED[file.mimetype] ? cb(null, true) : cb(new Error('Faqat rasm yoki video yuklash mumkin'))
});
const removeFile = (rel) => {
  if (!rel) return;
  const p = path.join(UPLOAD_DIR, path.basename(rel));
  fs.unlink(p, () => {});
};

/* ---------- App ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false }));
app.use(express.static(path.join(__dirname, 'public')));

const now = () => Date.now();

function signToken(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Kirish talab qilinadi' });
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!user) return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Sessiya tugagan, qayta kiring' });
  }
}
const publicUser = (u) => ({
  id: u.id, username: u.username, display_name: u.display_name,
  bio: u.bio, avatar: u.avatar
});

/* oddiy brute-force himoyasi */
const attempts = new Map();
function limiter(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const t = now();
    const rec = (attempts.get(key) || []).filter((x) => t - x < windowMs);
    if (rec.length >= max) return res.status(429).json({ error: "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring" });
    rec.push(t);
    attempts.set(key, rec);
    next();
  };
}

/* ---------- Auth ---------- */
app.post('/api/register', limiter(10, 10 * 60 * 1000), (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const display = String(req.body.display_name || '').trim().slice(0, 40) || username;
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_.]{3,20}$/.test(username))
    return res.status(400).json({ error: "Username 3-20 belgi: lotin harflari, raqam, _ yoki ." });
  if (password.length < 6) return res.status(400).json({ error: "Parol kamida 6 belgidan iborat bo'lsin" });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
    return res.status(409).json({ error: 'Bu username band' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)'
  ).run(username, display, hash, now());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/login', limiter(15, 10 * 60 * 1000), (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: "Username yoki parol noto'g'ri" });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  const unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE receiver_id = ? AND read = 0').get(req.user.id).c;
  res.json({ user: publicUser(req.user), unread });
});

app.put('/api/me', auth, upload.single('avatar'), (req, res) => {
  const display = String(req.body.display_name ?? req.user.display_name).trim().slice(0, 40) || req.user.username;
  const bio = String(req.body.bio ?? req.user.bio).slice(0, 200);
  let avatar = req.user.avatar;
  if (req.file) {
    if (!req.file.mimetype.startsWith('image/')) {
      removeFile(req.file.filename);
      return res.status(400).json({ error: 'Avatar rasm bo\'lishi kerak' });
    }
    removeFile(avatar);
    avatar = '/uploads/' + req.file.filename;
  }
  db.prepare('UPDATE users SET display_name=?, bio=?, avatar=? WHERE id=?').run(display, bio, avatar, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
});

/* ---------- Foydalanuvchilar / qidiruv / obuna ---------- */
const userRow = `
  u.id, u.username, u.display_name, u.bio, u.avatar,
  (SELECT COUNT(*) FROM follows WHERE following_id = u.id) AS followers,
  (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) AS following,
  (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS posts,
  EXISTS(SELECT 1 FROM follows WHERE follower_id = @me AND following_id = u.id) AS is_following
`;

// Qidiruv: q bo'sh bo'lsa — barcha ro'yxatdan o'tgan odamlar chiqadi
app.get('/api/users', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/[%_]/g, '');
  const rows = db.prepare(`
    SELECT ${userRow} FROM users u
    WHERE u.id != @me AND (@q = '' OR u.username LIKE @like OR LOWER(u.display_name) LIKE @like)
    ORDER BY u.created_at DESC LIMIT 50
  `).all({ me: req.user.id, q, like: `%${q}%` });
  res.json({ users: rows.map((r) => ({ ...r, is_following: !!r.is_following })) });
});

app.get('/api/users/:username', auth, (req, res) => {
  const u = db.prepare(`SELECT ${userRow} FROM users u WHERE u.username = @un`)
    .get({ me: req.user.id, un: req.params.username.toLowerCase() });
  if (!u) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  u.is_following = !!u.is_following;
  const posts = db.prepare(`${postSelect} WHERE p.user_id = @uid ORDER BY p.created_at DESC`)
    .all({ me: req.user.id, uid: u.id }).map(fmtPost);
  res.json({ user: u, posts });
});

app.post('/api/users/:id/follow', auth, (req, res) => {
  const target = Number(req.params.id);
  if (target === req.user.id) return res.status(400).json({ error: "O'zingizga obuna bo'la olmaysiz" });
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(target)) return res.status(404).json({ error: 'Topilmadi' });
  const has = db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(req.user.id, target);
  if (has) db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(req.user.id, target);
  else db.prepare('INSERT INTO follows VALUES (?,?,?)').run(req.user.id, target, now());
  const followers = db.prepare('SELECT COUNT(*) c FROM follows WHERE following_id=?').get(target).c;
  res.json({ is_following: !has, followers });
});

/* ---------- Postlar ---------- */
const postSelect = `
  SELECT p.id, p.media_path, p.media_type, p.caption, p.created_at,
    u.id AS user_id, u.username, u.display_name, u.avatar,
    (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likes,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comments,
    EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = @me) AS liked
  FROM posts p JOIN users u ON u.id = p.user_id
`;
const fmtPost = (p) => ({ ...p, liked: !!p.liked });

// scope=following (obuna bo'lganlar + o'zim) yoki scope=all (hamma)
app.get('/api/feed', auth, (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'following';
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const where = scope === 'all'
    ? 'WHERE p.created_at < @before'
    : `WHERE p.created_at < @before AND (p.user_id = @me OR p.user_id IN
         (SELECT following_id FROM follows WHERE follower_id = @me))`;
  const rows = db.prepare(`${postSelect} ${where} ORDER BY p.created_at DESC LIMIT 20`)
    .all({ me: req.user.id, before });
  res.json({ posts: rows.map(fmtPost) });
});

app.post('/api/posts', auth, upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Rasm yoki video tanlang' });
  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  const caption = String(req.body.caption || '').slice(0, 500);
  const info = db.prepare(
    'INSERT INTO posts (user_id, media_path, media_type, caption, created_at) VALUES (?,?,?,?,?)'
  ).run(req.user.id, '/uploads/' + req.file.filename, type, caption, now());
  const post = db.prepare(`${postSelect} WHERE p.id = @id`).get({ me: req.user.id, id: info.lastInsertRowid });
  res.json({ post: fmtPost(post) });
});

app.delete('/api/posts/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Topilmadi' });
  if (p.user_id !== req.user.id) return res.status(403).json({ error: 'Ruxsat yo\'q' });
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
  removeFile(p.media_path);
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(id)) return res.status(404).json({ error: 'Topilmadi' });
  const has = db.prepare('SELECT 1 FROM likes WHERE user_id=? AND post_id=?').get(req.user.id, id);
  if (has) db.prepare('DELETE FROM likes WHERE user_id=? AND post_id=?').run(req.user.id, id);
  else db.prepare('INSERT INTO likes VALUES (?,?)').run(req.user.id, id);
  const likes = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id=?').get(id).c;
  res.json({ liked: !has, likes });
});

app.get('/api/posts/:id/comments', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.text, c.created_at, u.username, u.display_name, u.avatar
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 200
  `).all(req.params.id);
  res.json({ comments: rows });
});

app.post('/api/posts/:id/comments', auth, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Izoh bo\'sh' });
  if (!db.prepare('SELECT 1 FROM posts WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Topilmadi' });
  const info = db.prepare('INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?,?,?,?)')
    .run(req.params.id, req.user.id, text, now());
  res.json({
    comment: {
      id: info.lastInsertRowid, text, created_at: now(),
      username: req.user.username, display_name: req.user.display_name, avatar: req.user.avatar
    }
  });
});

/* ---------- Xabarlar ---------- */
app.get('/api/conversations', auth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar,
      m.text AS last_text, m.created_at AS last_at, m.sender_id AS last_sender,
      (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = @me AND read = 0) AS unread
    FROM users u
    JOIN messages m ON m.id = (
      SELECT id FROM messages
      WHERE (sender_id = @me AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = @me)
      ORDER BY created_at DESC, id DESC LIMIT 1)
    ORDER BY m.created_at DESC
  `).all({ me });
  res.json({ conversations: rows });
});

app.get('/api/messages/:userId', auth, (req, res) => {
  const me = req.user.id, other = Number(req.params.userId);
  const after = Number(req.query.after) || 0;
  const peer = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id=?').get(other);
  if (!peer) return res.status(404).json({ error: 'Topilmadi' });
  const rows = db.prepare(`
    SELECT id, sender_id, text, created_at FROM messages
    WHERE id > @after AND ((sender_id=@me AND receiver_id=@o) OR (sender_id=@o AND receiver_id=@me))
    ORDER BY id ASC LIMIT 300
  `).all({ me, o: other, after });
  db.prepare('UPDATE messages SET read=1 WHERE sender_id=? AND receiver_id=? AND read=0').run(other, me);
  res.json({ peer, messages: rows });
});

app.post('/api/messages/:userId', auth, (req, res) => {
  const other = Number(req.params.userId);
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Xabar bo\'sh' });
  if (other === req.user.id) return res.status(400).json({ error: "O'zingizga yozib bo'lmaydi" });
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(other)) return res.status(404).json({ error: 'Topilmadi' });
  const t = now();
  const info = db.prepare('INSERT INTO messages (sender_id, receiver_id, text, created_at) VALUES (?,?,?,?)')
    .run(req.user.id, other, text, t);
  res.json({ message: { id: info.lastInsertRowid, sender_id: req.user.id, text, created_at: t } });
});

app.get('/api/unread', auth, (req, res) => {
  res.json({ unread: db.prepare('SELECT COUNT(*) c FROM messages WHERE receiver_id=? AND read=0').get(req.user.id).c });
});

/* ---------- Xatolar ---------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'Topilmadi' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Fayl juda katta (maks. 200MB)' : err.message || 'Server xatosi';
  res.status(err.code === 'LIMIT_FILE_SIZE' || err.message?.startsWith('Faqat') ? 400 : 500).json({ error: msg });
});

app.listen(PORT, () => console.log(`Videogram ishga tushdi: http://localhost:${PORT}`));
