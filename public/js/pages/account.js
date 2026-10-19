(async function () {
  const user = await App.init({ page: 'account' });
  const { DAYS, esc } = App;
  document.getElementById('pageSubtitle').textContent = `${user.name} · ${user.username}`;

  document.getElementById('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await App.api('/auth/password', { method: 'POST', body: { current: document.getElementById('cur').value, next: document.getElementById('nw').value } });
      App.toast('Password changed', 'success');
      e.target.reset();
    } catch (ex) { App.toast(ex.message, 'error'); }
  });

  if (user.role !== 'teacher') return;
  document.querySelector('.teacher-only').classList.remove('d-none');
  const { teacher } = await App.api('/teachers/me');
  document.getElementById('days').innerHTML = DAYS.map((d, i) => `<div class="form-check"><input class="form-check-input" type="checkbox" id="d${i}" value="${i}" ${teacher.available_days.includes(i) ? 'checked' : ''}>
    <label class="form-check-label" for="d${i}">${d}</label></div>`).join('');
  document.getElementById('myClasses').innerHTML = `<strong>My classes:</strong> ${teacher.classes.map((c) => `${esc(c.subject)} G${c.grade}`).join(', ') || 'none'} · ${teacher.weeklySessions} sessions a week`;
  document.getElementById('availForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = [...document.querySelectorAll('#days input:checked')].map((x) => Number(x.value));
    await App.api('/teachers/me/availability', { method: 'PUT', body: { available_days: days } });
    App.toast('Availability saved. The coordinator has been notified.', 'success');
  });
})();
