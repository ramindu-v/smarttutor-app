/* SmartTutor shared front-end code: page shell, API calls and helpers. */
(function () {
  const NAV = [
    { page: 'dashboard', href: 'dashboard.html', icon: 'fa-home', label: 'Dashboard', roles: ['admin', 'coordinator', 'teacher', 'student'] },
    { page: 'schedule', href: 'schedule.html', icon: 'fa-calendar-alt', label: 'Schedule', roles: ['admin', 'coordinator', 'teacher', 'student'] },
    { page: 'students', href: 'students.html', icon: 'fa-user-graduate', label: 'Students', roles: ['admin', 'coordinator', 'teacher'] },
    { page: 'teachers', href: 'teachers.html', icon: 'fa-chalkboard-teacher', label: 'Teachers', roles: ['admin', 'coordinator'] },
    { page: 'attendance', href: 'attendance.html', icon: 'fa-clipboard-check', label: 'Attendance', roles: ['admin', 'coordinator', 'teacher', 'student'] },
    { page: 'payments', href: 'payments.html', icon: 'fa-money-bill-wave', label: 'Payments', roles: ['admin', 'student'] },
    { page: 'reports', href: 'reports.html', icon: 'fa-chart-bar', label: 'Reports', roles: ['admin', 'coordinator'] },
    { page: 'notifications', href: 'notifications.html', icon: 'fa-bell', label: 'Notifications', roles: ['admin', 'coordinator', 'teacher', 'student'] },
    { page: 'account', href: 'account.html', icon: 'fa-user-cog', label: 'My account', roles: ['admin', 'coordinator', 'teacher', 'student'] },
  ];
  const PORTAL = { admin: 'Admin Portal', coordinator: 'Coordinator Portal', teacher: 'Teacher Portal', student: 'Student & Parent Portal' };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      location.href = 'index.html?next=' + encodeURIComponent(location.pathname.replace(/^\//, '') + location.search);
      throw new Error('Please log in');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  function toast(message, type = 'info') {
    let stack = document.querySelector('.toast-stack');
    if (!stack) { stack = document.createElement('div'); stack.className = 'toast-stack'; stack.setAttribute('aria-live', 'polite'); document.body.appendChild(stack); }
    const el = document.createElement('div');
    el.className = `toast-msg ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  // Bootstrap confirm dialog (no browser popups).
  function confirmBox(message, { title = 'Please confirm', ok = 'Yes', danger = false } = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <div class="modal fade" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
          <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
          <div class="modal-body">${esc(message)}</div>
          <div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-brand'}" data-ok>${esc(ok)}</button></div>
        </div></div></div>`;
      document.body.appendChild(wrap);
      const el = wrap.firstElementChild;
      const modal = new bootstrap.Modal(el);
      let answer = false;
      el.querySelector('[data-ok]').onclick = () => { answer = true; modal.hide(); };
      el.addEventListener('hidden.bs.modal', () => { wrap.remove(); resolve(answer); });
      modal.show();
    });
  }

  const initials = (name) => String(name || '').replace(/^(Mr|Mrs|Ms|Dr|Prof)\.\s*/, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-US');
  const pct = (v, digits = 0) => (v === null || v === undefined || Number.isNaN(v) ? '–' : (v * 100).toFixed(digits) + '%');
  const hour = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const subjClass = (s) => 'subj-' + String(s).replace(/\s+/g, '-');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtDate = (s) => (s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const fmtMonth = (m) => new Date(m + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const timeAgo = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return fmtDate(iso);
  };
  function riskPill(risk, declining) {
    const map = { high: ['bad', 'High risk'], medium: ['warn', 'Watch'], low: ['ok', 'On track'], unknown: ['muted', 'No data'] };
    const [cls, label] = map[risk] || map.unknown;
    return `<span class="pill ${cls}">${label}</span>` + (declining ? ' <span class="pill bad" title="Attendance is falling"><i class="fas fa-arrow-down"></i> Declining</span>' : '');
  }

  function renderShell(user, page, unread) {
    const items = NAV.filter((n) => n.roles.includes(user.role));
    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';
    sidebar.setAttribute('aria-label', 'Main');
    sidebar.innerHTML = `
      <div class="sidebar-header">
        <i class="fas fa-graduation-cap fa-3x"></i>
        <h4>SmartTutor</h4>
        <small>${esc(PORTAL[user.role])}</small>
      </div>
      <div class="nav-menu">
        ${items.map((n) => `<a href="${n.href}" class="${n.page === page ? 'active' : ''}"><i class="fas ${n.icon}"></i> ${n.label}
          ${n.page === 'notifications' && unread ? `<span class="badge bg-danger">${unread}</span>` : ''}</a>`).join('')}
        <a href="#" data-logout><i class="fas fa-sign-out-alt"></i> Logout</a>
      </div>
      <div class="sidebar-footer">FutureMinds Tuition Center, Kandy</div>`;
    document.body.prepend(sidebar);
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.onclick = () => document.body.classList.remove('nav-open');
    document.body.prepend(backdrop);

    const top = document.querySelector('.top-bar');
    if (top) {
      top.insertAdjacentHTML('afterbegin', '<button class="menu-toggle" aria-label="Open menu"><i class="fas fa-bars"></i></button>');
      top.insertAdjacentHTML('beforeend', `
        <div class="user-chip">
          <a class="bell" href="notifications.html" aria-label="Notifications"><i class="far fa-bell"></i>${unread ? `<span class="badge bg-danger">${unread}</span>` : ''}</a>
          <span class="user-name text-end"><strong>${esc(user.name)}</strong><br><small class="text-muted text-capitalize">${esc(user.role)}</small></span>
          <span class="avatar sm">${esc(initials(user.name))}</span>
        </div>`);
      top.querySelector('.menu-toggle').onclick = () => document.body.classList.toggle('nav-open');
    }
    sidebar.querySelector('[data-logout]').onclick = async (e) => {
      e.preventDefault();
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      location.href = 'index.html';
    };
  }

  // Every inner page calls App.init({ page, roles }) and gets the logged-in user.
  async function init({ page, roles }) {
    const { user } = await api('/auth/me');
    if (roles && !roles.includes(user.role)) { location.href = 'dashboard.html'; throw new Error('No access'); }
    let unread = 0;
    try { unread = (await api('/notifications')).unread; } catch { /* ignore */ }
    renderShell(user, page, unread);
    window.addEventListener('unhandledrejection', (e) => { if (e.reason && e.reason.message) toast(e.reason.message, 'error'); });
    return user;
  }

  function download(path) { location.href = '/api' + path; }

  // Fill a <select> from a list.
  function options(list, { value = 'id', label = 'name', selected, blank } = {}) {
    return (blank ? `<option value="">${esc(blank)}</option>` : '') +
      list.map((x) => {
        const v = typeof value === 'function' ? value(x) : x[value];
        const l = typeof label === 'function' ? label(x) : x[label];
        return `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(l)}</option>`;
      }).join('');
  }

  window.App = { api, toast, confirm: confirmBox, init, esc, initials, money, pct, hour, DAYS, subjClass, localDate, fmtDate, fmtMonth, timeAgo, riskPill, download, options };
})();
