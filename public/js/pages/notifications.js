(async function () {
  const user = await App.init({ page: 'notifications' });
  const { esc } = App;
  const staff = user.role === 'admin' || user.role === 'coordinator';
  document.querySelectorAll('.staff-only').forEach((x) => x.classList.toggle('d-none', !staff));
  const icons = { schedule: 'fa-calendar-alt text-primary', attendance: 'fa-clipboard-check text-danger', payment: 'fa-money-bill-wave text-success', announcement: 'fa-bullhorn text-warning', availability: 'fa-user-clock text-info' };

  async function load() {
    const d = await App.api('/notifications');
    document.getElementById('list').innerHTML = d.notifications.map((n) => `
      <div class="d-flex gap-3 p-3 rounded mb-2 ${n.read_at ? '' : 'bg-light border-start border-4 border-primary'}" data-id="${n.id}">
        <i class="fas ${icons[n.type] || 'fa-bell'} fa-lg mt-1"></i>
        <div class="flex-grow-1"><div class="d-flex justify-content-between gap-2"><strong>${esc(n.title)}</strong><small class="text-muted text-nowrap">${App.timeAgo(n.created_at)}</small></div>
          <div class="small" style="white-space:pre-line">${esc(n.body)}</div>
          ${n.read_at ? '' : '<button class="btn btn-link btn-sm p-0" data-read>Mark as read</button>'}</div>
      </div>`).join('') || '<div class="empty">No notifications yet</div>';
  }
  document.getElementById('list').onclick = async (e) => {
    if (!e.target.closest('[data-read]')) return;
    await App.api(`/notifications/${e.target.closest('[data-id]').dataset.id}/read`, { method: 'POST' });
    load();
  };
  document.getElementById('readAll').onclick = async () => { await App.api('/notifications/read-all', { method: 'POST' }); load(); document.querySelectorAll('.bell .badge, .nav-menu .badge').forEach((b) => b.remove()); };

  if (staff) {
    document.getElementById('sendForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await App.api('/notifications/send', { method: 'POST', body: { audience: document.getElementById('aud').value, title: document.getElementById('title').value, body: document.getElementById('body').value } });
        App.toast(`Sent to ${r.sent} people`, 'success');
        e.target.reset();
        load();
      } catch (ex) { App.toast(ex.message, 'error'); }
    });
    const { messages } = await App.api('/notifications/outbox');
    document.getElementById('outboxList').innerHTML = messages.map((m) => `<div class="border-bottom py-2 small"><strong>${esc(m.recipient)}</strong> <span class="text-muted">· ${App.timeAgo(m.created_at)}</span><br>${esc(m.body)}</div>`).join('')
      || '<div class="empty small">No messages yet. Mark a student absent or send fee reminders to see them here.</div>';
    if (new URLSearchParams(location.search).get('compose')) document.getElementById('title').focus();
    if (location.hash === '#outbox') document.getElementById('outbox').scrollIntoView();
  }
  load();
})();
