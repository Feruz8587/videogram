'use strict';

/* =====================================================================
   Videogram — frontend (vanilla JS, SPA, hash routing)
   ===================================================================== */

const $app = document.getElementById('app');
const state = { token: localStorage.getItem('vg_token'), me: null, unread: 0, cleanups: [] };

/* ---------- Kichik yordamchilar ---------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

const PATHS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/>',
  msg: '<path d="M22 3L2 10l8 3 3 8z"/><path d="M22 3L10 13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  heart: '<path d="M12 21s-8-5.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.5-8 11-8 11z"/>',
  comment: '<path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6A8 8 0 1 1 21 12z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  close: '<path d="M5 5l14 14M19 5L5 19"/>',
  logout: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 17l5-5-5-5M21 12H9"/>',
  volOn: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  volOff: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9l5 6M21 9l-5 6"/>',
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor"/>',
  back: '<path d="M15 5l-7 7 7 7"/>'
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
  return t.content.firstElementChild;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'hozir';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} daqiqa oldin`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} soat oldin`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d} kun oldin`;
  return new Date(ts).toLocaleDateString('uz-UZ', { day: 'numeric', month: 'long', year: 'numeric' });
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function avatarEl(u, cls = '') {
  if (u.avatar) return h('img', { class: 'avatar ' + cls, src: u.avatar, alt: '', loading: 'lazy' });
  return h('div', { class: 'avatar ' + cls }, (u.display_name || u.username || '?').trim().charAt(0));
}

/* ---------- API ---------- */
async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api' + path, { method, headers, body: payload }); }
  catch { throw new Error('Serverga ulanib bo\'lmadi'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && state.token) logout(true);
    throw new Error(data.error || 'Xatolik yuz berdi');
  }
  return data;
}

function xhrUpload(path, form, method, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, '/api' + path);
    x.setRequestHeader('Authorization', 'Bearer ' + state.token);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch { /* ignore */ }
      x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d.error || 'Yuklashda xatolik'));
    };
    x.onerror = () => reject(new Error('Tarmoq xatosi'));
    x.send(form);
  });
}

/* ---------- Video: ekranda ko'ringanda o'ynaydi ---------- */
const videoObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting && e.intersectionRatio >= 0.6) v.play().catch(() => {});
    else v.pause();
  }
}, { threshold: [0, 0.6, 1] });

function cleanup() {
  state.cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  state.cleanups = [];
  videoObserver.disconnect();
}

/* ---------- Modal ---------- */
function openModal(title, content, { wide = false, bare = false } = {}) {
  const bg = h('div', { class: 'modal-bg' });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { bg.remove(); document.removeEventListener('keydown', onKey); }
  const modal = h('div', { class: 'modal glass' + (wide ? ' wide' : '') },
    title ? h('h3', {}, title, h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Yopish' }, icon('close'))) : null,
    content);
  if (bare) modal.style.padding = '0';
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  bg.append(modal);
  document.body.append(bg);
  document.addEventListener('keydown', onKey);
  return { close };
}

/* ---------- Auth ---------- */
function authView(mode = 'login') {
  cleanup();
  const err = h('div', { class: 'err' });
  const username = h('input', { class: 'input', placeholder: 'Username (lotin harflari)', autocomplete: 'username', autocapitalize: 'none', required: '' });
  const display = h('input', { class: 'input', placeholder: 'Ismingiz', autocomplete: 'name', maxlength: '40' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'Parol (kamida 6 belgi)', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: '' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, mode === 'login' ? 'Kirish' : "Ro'yxatdan o'tish");

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.setAttribute('disabled', '');
      try {
        const body = { username: username.value, password: pass.value };
        if (mode === 'register') body.display_name = display.value;
        const r = await api(mode === 'login' ? '/login' : '/register', { method: 'POST', body });
        state.token = r.token;
        localStorage.setItem('vg_token', r.token);
        state.me = r.user;
        location.hash = '#/feed';
        route();
      } catch (ex) { err.textContent = ex.message; }
      submit.removeAttribute('disabled');
    }
  }, username, mode === 'register' ? display : null, pass, err, submit);

  $app.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card glass' },
      h('div', { class: 'logo' }, h('span', {}, 'Videogram')),
      h('p', {}, mode === 'login' ? "Do'stlaringizning video va rasmlarini ko'ring" : 'Yangi hisob yarating'),
      form,
      h('div', { class: 'switch' },
        mode === 'login' ? "Hisobingiz yo'qmi? " : 'Hisobingiz bormi? ',
        h('button', { onclick: () => authView(mode === 'login' ? 'register' : 'login') }, mode === 'login' ? "Ro'yxatdan o'tish" : 'Kirish')))));
}

function logout(silent) {
  state.token = null; state.me = null; state.unread = 0;
  localStorage.removeItem('vg_token');
  cleanup();
  authView();
  if (silent) toast('Sessiya tugadi, qayta kiring');
}

/* ---------- Shell (sidebar + bottom nav) ---------- */
function updateBadge() {
  document.querySelectorAll('.badge-msg').forEach((b) => {
    b.textContent = state.unread > 99 ? '99+' : state.unread;
    b.style.display = state.unread > 0 ? '' : 'none';
  });
}

function shell(active, main) {
  const items = [
    { id: 'feed', label: 'Bosh sahifa', ic: 'home', go: '#/feed' },
    { id: 'search', label: 'Qidiruv', ic: 'search', go: '#/search' },
    { id: 'upload', label: 'Yaratish', ic: 'plus', act: openUpload },
    { id: 'messages', label: 'Xabarlar', ic: 'msg', go: '#/messages', badge: true },
    { id: 'profile', label: 'Profil', ic: 'user', go: '#/u/' + state.me.username }
  ];
  const mk = (it, cls) => h('button', {
    class: cls + (it.id === active ? ' active' : ''),
    'aria-label': it.label,
    onclick: () => (it.act ? it.act() : (location.hash = it.go))
  }, icon(it.ic), cls === 'nav-item' ? it.label : null,
  it.badge ? h('span', { class: 'badge badge-msg', style: 'display:none' }, '0') : null);

  const side = h('nav', { class: 'side glass' },
    h('div', { class: 'logo' }, h('span', {}, 'Videogram')),
    items.map((it) => mk(it, 'nav-item')),
    h('div', { class: 'spacer' }),
    h('button', { class: 'nav-item', onclick: () => logout() }, icon('logout'), 'Chiqish'));
  const bottom = h('nav', { class: 'bottom-nav glass' }, items.map((it) => mk(it, 'bn')));
  $app.replaceChildren(h('div', { class: 'shell' }, side, h('main', {}, main)), bottom);
  updateBadge();
  window.scrollTo(0, 0);
}

/* ---------- Post kartasi ---------- */
function postCard(p, opts = {}) {
  let liked = p.liked, likes = p.likes, ccount = p.comments;
  const card = h('article', { class: 'post' + (opts.bare ? '' : ' glass') });
  const likeCount = h('div', { class: 'likes' });
  const likeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Yoqdi', onclick: toggleLike }, icon('heart'));
  const cBtn = h('button', { class: 'viewc', onclick: openComments });
  const burst = h('div', { class: 'heart-burst' }, icon('heart'));

  function upd() {
    likeBtn.classList.toggle('liked', liked);
    likeCount.textContent = `${likes} ta yoqdi`;
    cBtn.textContent = ccount ? `${ccount} ta izohni ko'rish` : 'Izoh qoldirish';
  }
  async function toggleLike() {
    liked = !liked; likes += liked ? 1 : -1; upd();
    try { const r = await api(`/posts/${p.id}/like`, { method: 'POST' }); liked = r.liked; likes = r.likes; }
    catch (e) { liked = !liked; likes += liked ? 1 : -1; toast(e.message); }
    upd();
  }
  function openComments() {
    openCommentsModal(p, (n) => { ccount = n; upd(); });
  }

  const media = h('div', { class: 'media' });
  if (p.media_type === 'video') {
    const v = h('video', { src: p.media_path, loop: '', playsinline: '', preload: 'metadata' });
    v.muted = true;
    v.addEventListener('click', () => (v.paused ? v.play() : v.pause()));
    const mute = h('button', { class: 'mute', 'aria-label': 'Ovoz', onclick: (e) => {
      e.stopPropagation(); v.muted = !v.muted;
      mute.replaceChildren(icon(v.muted ? 'volOff' : 'volOn'));
    } }, icon('volOff'));
    media.append(v, mute);
    videoObserver.observe(v);
  } else {
    media.append(h('img', { src: p.media_path, alt: p.caption || '', loading: 'lazy' }));
  }
  media.append(burst);
  media.addEventListener('dblclick', () => {
    if (!liked) toggleLike();
    burst.classList.remove('go'); void burst.offsetWidth; burst.classList.add('go');
  });

  const head = h('div', { class: 'post-head' },
    h('a', { href: '#/u/' + p.username }, avatarEl(p)),
    h('div', { class: 'who' },
      h('a', { href: '#/u/' + p.username }, h('b', {}, p.display_name)),
      h('small', {}, '@' + p.username)),
    state.me && p.user_id === state.me.id && opts.onDelete
      ? h('button', { class: 'icon-btn', 'aria-label': "O'chirish", onclick: async () => {
        if (!confirm("Bu postni o'chirasizmi?")) return;
        try { await api('/posts/' + p.id, { method: 'DELETE' }); opts.onDelete(); toast("Post o'chirildi"); }
        catch (e) { toast(e.message); }
      } }, icon('trash'))
      : null);

  card.append(head, media,
    h('div', { class: 'post-actions' }, likeBtn,
      h('button', { class: 'icon-btn', 'aria-label': 'Izoh', onclick: openComments }, icon('comment'))),
    h('div', { class: 'post-body' }, likeCount,
      p.caption ? h('div', { class: 'cap' }, h('b', {}, p.username), p.caption) : null,
      cBtn,
      h('div', { class: 'when' }, timeAgo(p.created_at))));
  upd();
  return card;
}

function openCommentsModal(p, onCount) {
  const list = h('div', { class: 'comments' }, h('div', { class: 'muted' }, 'Yuklanmoqda...'));
  const input = h('input', { class: 'input', placeholder: "Izoh yozing...", maxlength: '500' });
  const send = h('button', { class: 'btn primary small', type: 'submit' }, 'Yuborish');
  let count = 0;
  const row = (c) => h('div', { class: 'comment' }, avatarEl(c, 'sm'),
    h('div', {}, h('p', {}, h('b', {}, c.username + ' '), c.text), h('small', {}, timeAgo(c.created_at))));

  api(`/posts/${p.id}/comments`).then(({ comments }) => {
    count = comments.length;
    list.replaceChildren(...(comments.length ? comments.map(row) : [h('div', { class: 'muted' }, "Hozircha izoh yo'q. Birinchi bo'ling!")]));
  }).catch((e) => { list.textContent = e.message; });

  const form = h('form', { class: 'comment-form', onsubmit: async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.setAttribute('disabled', '');
    try {
      const { comment } = await api(`/posts/${p.id}/comments`, { method: 'POST', body: { text } });
      if (!count) list.replaceChildren();
      list.append(row(comment)); list.scrollTop = list.scrollHeight;
      input.value = ''; count++; onCount(count);
    } catch (ex) { toast(ex.message); }
    send.removeAttribute('disabled');
  } }, input, send);
  openModal('Izohlar', h('div', {}, list, form));
  input.focus();
}

/* ---------- Bosh sahifa (lenta) ---------- */
function feedView() {
  const stored = sessionStorage.getItem('vg_scope');
  let scope = stored || 'following';
  let before = null, loading = false, done = false;
  const list = h('div');
  const sentinel = h('div', { style: 'height:1px' });
  const tabBtn = (id, label) => h('button', { class: scope === id ? 'active' : '', onclick: () => { scope = id; sessionStorage.setItem('vg_scope', id); setTabs(); reset(); } }, label);
  const tabs = h('div', { class: 'tabs glass' });
  function setTabs() { tabs.replaceChildren(tabBtn('following', 'Obunalar'), tabBtn('all', 'Hammasi')); }

  function reset() { list.replaceChildren(); before = null; done = false; load(true); }

  async function load(first) {
    if (loading || done) return;
    loading = true;
    try {
      const { posts } = await api(`/feed?scope=${scope}` + (before ? `&before=${before}` : ''));
      if (!posts.length) {
        done = true;
        if (first) {
          if (scope === 'following' && !stored) { scope = 'all'; setTabs(); loading = false; return reset(); }
          list.append(h('div', { class: 'empty glass' },
            h('b', {}, scope === 'following' ? 'Lenta bo\'sh' : "Hali postlar yo'q"),
            scope === 'following' ? "Qidiruvdan odamlarga obuna bo'ling yoki «Hammasi» bo'limini oching." : "Birinchi bo'lib video yoki rasm joylang!",
            h('div', { style: 'margin-top:16px' },
              h('button', { class: 'btn primary', onclick: () => (scope === 'following' ? (location.hash = '#/search') : openUpload()) },
                scope === 'following' ? 'Odamlarni qidirish' : 'Post yaratish'))));
        }
      } else {
        posts.forEach((p) => {
          const card = postCard(p, { onDelete: () => card.remove() });
          list.append(card);
        });
        before = posts[posts.length - 1].created_at;
        if (posts.length < 20) done = true;
      }
    } catch (e) { toast(e.message); }
    loading = false;
  }

  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) load(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  state.cleanups.push(() => io.disconnect());

  setTabs();
  shell('feed', h('div', {}, tabs, list, sentinel));
  load(true);
}

/* ---------- Qidiruv ---------- */
function followBtn(u, onChange) {
  const b = h('button', { class: 'btn small' });
  const set = () => { b.textContent = u.is_following ? 'Obunasiz' : 'Obuna bo\'lish'; b.classList.toggle('primary', !u.is_following); };
  b.addEventListener('click', async () => {
    b.setAttribute('disabled', '');
    try {
      const r = await api(`/users/${u.id}/follow`, { method: 'POST' });
      u.is_following = r.is_following; u.followers = r.followers; set(); onChange && onChange(r);
    } catch (e) { toast(e.message); }
    b.removeAttribute('disabled');
  });
  set();
  return b;
}

function searchView() {
  const results = h('div');
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Odam qidiring (ism yoki username)...', autocomplete: 'off' });
  let timer, seq = 0;

  async function run() {
    const my = ++seq;
    try {
      const { users } = await api('/users?q=' + encodeURIComponent(input.value.trim()));
      if (my !== seq) return;
      if (!users.length) {
        results.replaceChildren(h('div', { class: 'empty glass' }, h('b', {}, input.value.trim() ? 'Hech kim topilmadi' : "Hozircha boshqa foydalanuvchi yo'q"),
          input.value.trim() ? "Boshqa nom bilan urinib ko'ring." : "Do'stlaringizni taklif qiling — ro'yxatdan o'tishi bilan shu yerda chiqadi."));
        return;
      }
      results.replaceChildren(...users.map((u) => h('div', { class: 'user-row glass' },
        h('a', { href: '#/u/' + u.username }, avatarEl(u)),
        h('div', { class: 'who', onclick: () => (location.hash = '#/u/' + u.username) },
          h('b', {}, u.display_name),
          h('small', {}, `@${u.username} · ${u.followers} ta obunachi`)),
        h('div', { class: 'acts' },
          followBtn(u),
          h('button', { class: 'btn small', 'aria-label': 'Xabar', onclick: () => (location.hash = '#/chat/' + u.username) }, icon('msg').cloneNode(true))))));
      results.querySelectorAll('.acts .btn svg').forEach((s) => { s.style.width = '18px'; s.style.height = '18px'; s.style.display = 'block'; });
    } catch (e) { results.replaceChildren(h('div', { class: 'empty' }, e.message)); }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  state.cleanups.push(() => clearTimeout(timer));

  shell('search', h('div', {}, h('div', { class: 'page-title' }, 'Qidiruv'), h('div', { class: 'search-bar' }, input), results));
  run();
}

/* ---------- Profil ---------- */
async function profileView(username) {
  const box = h('div', {}, h('div', { class: 'empty' }, 'Yuklanmoqda...'));
  shell(username === state.me.username ? 'profile' : '', box);
  try {
    const { user, posts } = await api('/users/' + encodeURIComponent(username));
    const isMe = user.id === state.me.id;
    const counts = {
      posts: h('b', {}, user.posts), followers: h('b', {}, user.followers)
    };
    const btns = h('div', { class: 'profile-btns' });
    if (isMe) {
      btns.append(h('button', { class: 'btn small', onclick: () => openEditProfile((u) => { state.me = u; route(); }) }, 'Profilni tahrirlash'),
        h('button', { class: 'btn small', onclick: () => logout() }, 'Chiqish'));
    } else {
      btns.append(followBtn(user, (r) => { counts.followers.textContent = r.followers; }),
        h('button', { class: 'btn small', onclick: () => (location.hash = '#/chat/' + user.username) }, 'Xabar yozish'));
    }
    const head = h('div', { class: 'profile-head glass' },
      avatarEl(user, 'lg'),
      h('div', { class: 'info' },
        h('h2', {}, user.display_name),
        h('div', { class: 'muted' }, '@' + user.username),
        h('div', { class: 'counts' },
          h('div', {}, counts.posts, h('small', {}, 'post')),
          h('div', {}, counts.followers, h('small', {}, 'obunachi')),
          h('div', {}, h('b', {}, user.following), h('small', {}, 'obuna'))),
        user.bio ? h('p', { class: 'bio' }, user.bio) : null,
        btns));

    const grid = h('div', { class: 'grid' });
    const renderGrid = () => {
      if (!posts.length) {
        grid.replaceWith(h('div', { class: 'empty glass' }, h('b', {}, 'Hali postlar yo\'q'), isMe ? 'Birinchi video yoki rasmingizni joylang!' : ''));
        return;
      }
      grid.replaceChildren(...posts.map((p) => {
        const cell = h('div', { class: 'cell', onclick: () => {
          const m = openModal(null, postCard(p, { bare: true, onDelete: () => {
            m.close(); posts.splice(posts.indexOf(p), 1); cell.remove(); counts.posts.textContent = posts.length;
            if (!posts.length) renderGrid();
          } }), { wide: true, bare: true });
        } },
        p.media_type === 'video' ? h('video', { src: p.media_path + '#t=0.1', preload: 'metadata', muted: '', playsinline: '' }) : h('img', { src: p.media_path, alt: '', loading: 'lazy' }),
        p.media_type === 'video' ? h('span', { class: 'tag' }, icon('play')) : null,
        h('div', { class: 'ov' }, `♥ ${p.likes}`, `💬 ${p.comments}`));
        return cell;
      }));
    };
    box.replaceChildren(head, grid);
    renderGrid();
  } catch (e) {
    box.replaceChildren(h('div', { class: 'empty glass' }, h('b', {}, 'Topilmadi'), e.message));
  }
}

function openEditProfile(onSaved) {
  const name = h('input', { class: 'input', value: state.me.display_name, maxlength: '40', placeholder: 'Ism' });
  const bio = h('textarea', { class: 'input', rows: '3', maxlength: '200', placeholder: "O'zingiz haqingizda" }, state.me.bio || '');
  const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  const prev = h('div', { style: 'display:flex;align-items:center;gap:14px' }, avatarEl(state.me, 'lg'),
    h('button', { class: 'btn small', type: 'button', onclick: () => file.click() }, 'Rasmni almashtirish'));
  file.addEventListener('change', () => {
    if (file.files[0]) prev.firstChild.replaceWith(h('img', { class: 'avatar lg', src: URL.createObjectURL(file.files[0]), alt: '' }));
  });
  const err = h('div', { class: 'err' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Saqlash');
  const m = openModal('Profilni tahrirlash', h('form', { onsubmit: async (e) => {
    e.preventDefault(); save.setAttribute('disabled', '');
    const fd = new FormData();
    fd.append('display_name', name.value); fd.append('bio', bio.value);
    if (file.files[0]) fd.append('avatar', file.files[0]);
    try { const { user } = await api('/me', { method: 'PUT', form: fd }); m.close(); onSaved(user); toast('Saqlandi'); }
    catch (ex) { err.textContent = ex.message; save.removeAttribute('disabled'); }
  } }, prev, file, name, bio, err, save));
}

/* ---------- Post yaratish ---------- */
function openUpload() {
  const file = h('input', { type: 'file', accept: 'image/*,video/*', style: 'display:none' });
  const drop = h('div', { class: 'drop', onclick: () => file.click() }, 'Video yoki rasmni tanlang yoki shu yerga tashlang');
  const caption = h('textarea', { class: 'input', rows: '3', maxlength: '500', placeholder: 'Tavsif yozing...' });
  const bar = h('i'); const progress = h('div', { class: 'progress' }, bar);
  const err = h('div', { class: 'err' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Joylash');
  let chosen = null;

  function pick(f) {
    if (!f) return;
    if (!/^(image|video)\//.test(f.type)) { err.textContent = 'Faqat rasm yoki video'; return; }
    if (f.size > 200 * 1024 * 1024) { err.textContent = 'Fayl 200MB dan oshmasligi kerak'; return; }
    err.textContent = ''; chosen = f;
    const url = URL.createObjectURL(f);
    drop.replaceChildren(f.type.startsWith('video/')
      ? h('video', { src: url, controls: '', muted: '', playsinline: '' })
      : h('img', { src: url, alt: '' }));
  }
  file.addEventListener('change', () => pick(file.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));

  const m = openModal('Yangi post', h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (!chosen) { err.textContent = 'Avval rasm yoki video tanlang'; return; }
    const fd = new FormData();
    fd.append('caption', caption.value); fd.append('media', chosen);
    submit.setAttribute('disabled', ''); progress.style.display = 'block'; err.textContent = '';
    try {
      await xhrUpload('/posts', fd, 'POST', (r) => { bar.style.width = (r * 100).toFixed(0) + '%'; });
      m.close(); toast('Joylandi!');
      sessionStorage.setItem('vg_scope', 'all');
      if (location.hash === '#/feed' || location.hash === '' || location.hash === '#/') route(); else location.hash = '#/feed';
    } catch (ex) { err.textContent = ex.message; submit.removeAttribute('disabled'); progress.style.display = 'none'; }
  } }, drop, file, caption, progress, err, submit), { wide: true });
}

/* ---------- Xabarlar ---------- */
async function messagesView() {
  const list = h('div', { class: 'chat-list' }, h('div', { class: 'empty' }, 'Yuklanmoqda...'));
  shell('messages', h('div', {}, h('div', { class: 'page-title' }, 'Xabarlar'), list));
  async function load() {
    try {
      const { conversations } = await api('/conversations');
      if (!conversations.length) {
        list.replaceChildren(h('div', { class: 'empty glass' }, h('b', {}, "Hali yozishmalar yo'q"), "Qidiruvdan odamni toping va birinchi xabarni yozing.",
          h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn primary', onclick: () => (location.hash = '#/search') }, 'Odam qidirish'))));
        return;
      }
      list.replaceChildren(...conversations.map((c) => h('div', { class: 'user-row glass', onclick: () => (location.hash = '#/chat/' + c.username) },
        avatarEl(c),
        h('div', { class: 'who' }, h('b', {}, c.display_name),
          h('small', { class: c.unread ? 'unread-t' : '' }, (c.last_sender === state.me.id ? 'Siz: ' : '') + c.last_text)),
        c.unread ? h('span', { class: 'badge' }, c.unread) : h('small', { class: 'muted' }, clock(c.last_at)))));
    } catch (e) { list.textContent = e.message; }
  }
  await load();
  const t = setInterval(load, 5000);
  state.cleanups.push(() => clearInterval(t));
}

async function chatView(username) {
  const msgs = h('div', { class: 'messages' });
  const box = h('div', { class: 'chat-box' });
  shell('messages', box);
  let peer, last = 0;
  try {
    const { user } = await api('/users/' + encodeURIComponent(username));
    peer = user;
  } catch (e) { box.append(h('div', { class: 'empty glass' }, h('b', {}, 'Topilmadi'), e.message)); return; }
  if (peer.id === state.me.id) { location.hash = '#/messages'; return; }

  const bubble = (m) => h('div', { class: 'bubble' + (m.sender_id === state.me.id ? ' me' : '') }, m.text, h('time', {}, clock(m.created_at)));
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120;
  const add = (arr, force) => {
    if (!arr.length) return;
    const stick = force || nearBottom();
    arr.forEach((m) => { msgs.append(bubble(m)); last = Math.max(last, m.id); });
    if (stick) msgs.scrollTop = msgs.scrollHeight;
  };
  async function poll(first) {
    try {
      const r = await api(`/messages/${peer.id}?after=${last}`);
      if (first && !r.messages.length) msgs.append(h('div', { class: 'empty' }, `${peer.display_name} bilan suhbatni boshlang 👋`));
      else if (r.messages.length && msgs.querySelector('.empty')) msgs.replaceChildren();
      add(r.messages, first);
      if (r.messages.length) { const u = await api('/unread'); state.unread = u.unread; updateBadge(); }
    } catch { /* keyingi poll'da qayta urinadi */ }
  }

  const input = h('input', { class: 'input', placeholder: 'Xabar yozing...', maxlength: '2000', autocomplete: 'off' });
  const form = h('form', { class: 'msg-form', onsubmit: async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const { message } = await api(`/messages/${peer.id}`, { method: 'POST', body: { text } });
      if (msgs.querySelector('.empty')) msgs.replaceChildren();
      add([message], true);
    } catch (ex) { toast(ex.message); input.value = text; }
  } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Yuborish'));

  box.append(
    h('div', { class: 'chat-head glass' },
      h('button', { class: 'icon-btn', 'aria-label': 'Orqaga', onclick: () => (location.hash = '#/messages') }, icon('back')),
      h('a', { href: '#/u/' + peer.username }, avatarEl(peer, 'sm')),
      h('b', {}, peer.display_name)),
    msgs, form);
  await poll(true);
  input.focus();
  const t = setInterval(() => poll(false), 2500);
  state.cleanups.push(() => clearInterval(t));
}

/* ---------- Router ---------- */
function route() {
  cleanup();
  if (!state.me) return authView();
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const a = arg ? decodeURIComponent(arg) : '';
  if (name === 'search') return searchView();
  if (name === 'messages') return messagesView();
  if (name === 'chat' && a) return chatView(a);
  if (name === 'u' && a) return profileView(a);
  return feedView();
}
window.addEventListener('hashchange', route);

/* ---------- Boshlash ---------- */
(async function boot() {
  if (state.token) {
    try {
      const r = await api('/me');
      state.me = r.user; state.unread = r.unread;
    } catch { state.token = null; }
  }
  route();
  setInterval(async () => {
    if (!state.me) return;
    try { const r = await api('/unread'); if (r.unread !== state.unread) { state.unread = r.unread; updateBadge(); } } catch { /* ignore */ }
  }, 6000);
})();
