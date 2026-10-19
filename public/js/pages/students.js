(async function () {
  const user = await App.init({ page: 'students', roles: ['admin', 'coordinator', 'teacher'] });
  const { esc, pct } = App;
  const admin = user.role === 'admin';
  const meta = await App.api('/meta');
  const PAGE = 25;
  let all = [], shown = [], page = 1;

  document.querySelectorAll('.admin-only').forEach((x) => x.classList.toggle('d-none', !admin));
  if (user.role === 'teacher') document.getElementById('pageSubtitle').textContent = 'Students in your classes';
  document.getElementById('fGrade').innerHTML += meta.grades.map((g) => `<option value="${g}">Grade ${g}</option>`).join('');
  document.getElementById('fSubject').innerHTML += meta.subjects.map((s) => `<option>${esc(s)}</option>`).join('');
  document.getElementById('eGrade').innerHTML = meta.grades.map((g) => `<option value="${g}">Grade ${g}</option>`).join('');
  document.getElementById('eBranch').innerHTML = App.options(meta.branches);

  async function load() {
    const params = new URLSearchParams();
    for (const [k, id] of [['grade', 'fGrade'], ['status', 'fStatus'], ['subject', 'fSubject']]) {
      const v = document.getElementById(id).value; if (v) params.set(k, v);
    }
    const data = await App.api('/students?' + params);
    all = data.students;
    const s = data.summary;
    document.getElementById('summary').innerHTML = [
      ['fa-users text-primary', s.total, 'Total students'], ['fa-user-check text-success', s.active, 'Active students'],
      ['fa-user-plus text-info', s.newThisMonth, 'New this month'], ['fa-chart-line text-warning', pct(s.averageAttendance), 'Average attendance'],
    ].map(([icon, n, label]) => `<div class="col-6 col-md-3"><div class="stat-card text-center"><i class="fas ${icon} fa-2x mb-2"></i><h3>${n}</h3><p class="text-muted mb-0">${label}</p></div></div>`).join('');
    filter();
  }

  function filter() {
    const q = document.getElementById('q').value.trim().toLowerCase();
    const risk = document.getElementById('fRisk').value;
    shown = all.filter((s) => (!q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
      && (!risk || (risk === 'declining' ? s.prediction?.declining : s.prediction?.risk === risk)));
    page = 1;
    render();
  }

  function render() {
    document.getElementById('count').textContent = `(${shown.length})`;
    const rows = shown.slice((page - 1) * PAGE, page * PAGE);
    document.getElementById('rows').innerHTML = rows.length ? rows.map((s) => `
      <tr>
        <td><div class="d-flex align-items-center gap-2"><span class="avatar sm">${esc(App.initials(s.name))}</span>
          <div><a href="#" data-view="${s.id}"><strong>${esc(s.name)}</strong></a><br><small class="text-muted">${esc(s.code)} · ${esc(s.branch.split(' - ').pop())}</small></div></div></td>
        <td><span class="pill info">Grade ${s.grade}</span></td>
        <td class="small">${esc(s.subjects || '–')}</td>
        <td>${pct(s.attendanceRate)}</td>
        <td>${s.prediction ? `${App.riskPill(s.prediction.risk, s.prediction.declining)}<div class="small text-muted">${pct(s.prediction.probability)} likely next class</div>` : '<span class="pill muted">No data</span>'}</td>
        <td><span class="pill ${s.status === 'active' ? 'ok' : 'muted'}">${s.status}</span></td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-primary" data-view="${s.id}" title="View" aria-label="View"><i class="fas fa-eye"></i></button>
          ${admin ? `<button class="btn btn-sm btn-outline-warning" data-edit="${s.id}" title="Edit" aria-label="Edit"><i class="fas fa-edit"></i></button>
          <button class="btn btn-sm btn-outline-danger" data-del="${s.id}" title="Delete" aria-label="Delete"><i class="fas fa-trash"></i></button>` : ''}
        </td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">No students match these filters</td></tr>';
    const pages = Math.ceil(shown.length / PAGE);
    const btn = (p, label, disabled, active) => `<li class="page-item ${disabled ? 'disabled' : ''} ${active ? 'active' : ''}"><a class="page-link" href="#" data-page="${p}">${label}</a></li>`;
    const nums = [];
    for (let p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - page) <= 2) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
    document.getElementById('pager').innerHTML = pages > 1
      ? btn(page - 1, 'Previous', page === 1) + nums.map((p) => (p === '…' ? '<li class="page-item disabled"><span class="page-link">…</span></li>' : btn(p, p, false, p === page))).join('') + btn(page + 1, 'Next', page === pages)
      : '';
  }

  document.getElementById('pager').onclick = (e) => {
    const a = e.target.closest('[data-page]'); if (!a) return;
    e.preventDefault();
    page = Number(a.dataset.page); render();
    window.scrollTo({ top: document.getElementById('rows').offsetTop - 120, behavior: 'smooth' });
  };
  document.getElementById('rows').onclick = async (e) => {
    const v = e.target.closest('[data-view]'), ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (v) { e.preventDefault(); view(Number(v.dataset.view)); }
    if (ed) edit(Number(ed.dataset.edit));
    if (del) {
      const s = all.find((x) => x.id === Number(del.dataset.del));
      if (await App.confirm(`Delete ${s.name}? Their attendance, marks and payments will be removed too. To keep the history, edit the student and set them to inactive instead.`, { ok: 'Delete', danger: true })) {
        await App.api('/students/' + s.id, { method: 'DELETE' });
        App.toast(`${s.name} was deleted`, 'success');
        load();
      }
    }
  };
  let timer;
  document.getElementById('q').oninput = () => { clearTimeout(timer); timer = setTimeout(filter, 200); };
  document.getElementById('fRisk').onchange = filter;
  ['fGrade', 'fStatus', 'fSubject'].forEach((id) => { document.getElementById(id).onchange = load; });
  document.getElementById('exportBtn').onclick = () => App.download('/reports/students.csv');

  // ---------- add / edit
  const editModal = new bootstrap.Modal(document.getElementById('editModal'));
  const f = (id) => document.getElementById(id);
  let editing = null, enrolled = [];

  async function fillClasses() {
    const { classes } = await App.api(`/classes?branch=${f('eBranch').value}&grade=${f('eGrade').value}`);
    f('eClasses').innerHTML = classes.length ? classes.map((c) => `
      <div class="col-md-4"><div class="form-check"><input class="form-check-input" type="checkbox" value="${c.id}" id="ec${c.id}" ${enrolled.includes(c.id) ? 'checked' : ''}>
      <label class="form-check-label" for="ec${c.id}">${esc(c.subject)} <small class="text-muted">${App.money(c.monthly_fee)}/month</small></label></div></div>`).join('')
      : '<div class="text-muted small">No classes for this grade at this branch yet.</div>';
  }
  f('eGrade').onchange = () => { enrolled = []; fillClasses(); };
  f('eBranch').onchange = () => { enrolled = []; fillClasses(); };

  async function edit(id) {
    editing = id || null;
    f('editForm').reset();
    f('editError').classList.add('d-none');
    f('editTitle').textContent = id ? 'Edit student' : 'Add new student';
    f('loginBox').classList.toggle('d-none', !!id);
    enrolled = [];
    if (id) {
      const d = await App.api('/students/' + id);
      const s = d.student;
      f('eName').value = s.name; f('eDob').value = s.dob || ''; f('eStatus').value = s.status; f('eGrade').value = s.grade;
      f('eBranch').value = s.branch_id; f('eEmail').value = s.email || ''; f('ePhone').value = s.phone || '';
      f('eParent').value = s.parent_name || ''; f('eParentPhone').value = s.parent_phone || ''; f('eAddress').value = s.address || '';
      enrolled = d.classes.map((c) => c.id);
    }
    await fillClasses();
    editModal.show();
  }
  f('addBtn').onclick = () => edit(null);

  f('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: f('eName').value, dob: f('eDob').value || null, status: f('eStatus').value, grade: Number(f('eGrade').value),
      branch_id: Number(f('eBranch').value), email: f('eEmail').value, phone: f('ePhone').value, parent_name: f('eParent').value,
      parent_phone: f('eParentPhone').value, address: f('eAddress').value,
      classIds: [...document.querySelectorAll('#eClasses input:checked')].map((x) => Number(x.value)),
    };
    if (!editing && f('ePassword').value) body.password = f('ePassword').value;
    try {
      const r = await App.api(editing ? '/students/' + editing : '/students', { method: editing ? 'PUT' : 'POST', body });
      editModal.hide();
      App.toast(editing ? 'Student updated' : `${r.student.name} registered as ${r.student.code}`, 'success');
      load();
    } catch (ex) {
      f('editError').textContent = ex.message;
      f('editError').classList.remove('d-none');
    }
  });

  // ---------- profile
  const viewModal = new bootstrap.Modal(document.getElementById('viewModal'));
  let chart;
  async function view(id) {
    const d = await App.api('/students/' + id);
    const s = d.student, p = d.prediction;
    f('viewTitle').textContent = `${s.name} (${s.code})`;
    const teacherClasses = user.role === 'teacher' ? d.classes.filter((c) => c.teacher === user.name) : d.classes;
    f('viewBody').innerHTML = `
      <div class="row g-4">
        <div class="col-lg-4">
          <div class="text-center mb-3"><span class="avatar" style="width:72px;height:72px;font-size:1.5rem">${esc(App.initials(s.name))}</span>
            <h5 class="mt-2 mb-0">${esc(s.name)}</h5><span class="pill info">Grade ${s.grade}</span> <span class="pill ${s.status === 'active' ? 'ok' : 'muted'}">${s.status}</span></div>
          <table class="table table-sm small">
            <tr><th>Branch</th><td>${esc(s.branch)}</td></tr>
            <tr><th>Date of birth</th><td>${App.fmtDate(s.dob)}</td></tr>
            <tr><th>Phone</th><td>${esc(s.phone || '–')}</td></tr>
            <tr><th>Email</th><td>${esc(s.email || '–')}</td></tr>
            <tr><th>Parent</th><td>${esc(s.parent_name || '–')}<br>${esc(s.parent_phone || '')}</td></tr>
            <tr><th>Address</th><td>${esc(s.address || '–')}</td></tr>
            <tr><th>Joined</th><td>${App.fmtDate(s.joined_on)}</td></tr>
            <tr><th>Portal login</th><td>${d.hasLogin ? 'Yes' : 'No'}</td></tr>
          </table>
        </div>
        <div class="col-lg-8">
          <div class="ai-card mb-3 py-3">
            <i class="fas fa-brain ai-icon"></i>
            <h6 class="mb-2"><i class="fas fa-robot me-2"></i>AI attendance prediction</h6>
            <div class="d-flex flex-wrap gap-4 align-items-center">
              <div><div class="fs-3 fw-bold">${pct(p.probability)}</div><small>chance of attending the next class</small></div>
              <div><div class="fs-5 fw-bold">${pct(p.rate)}</div><small>attended so far</small></div>
              <div><div class="fs-5 fw-bold">${pct(p.earlierRate)} → ${pct(p.recentRate)}</div><small>earlier → recent weeks</small></div>
              <div>${App.riskPill(p.risk, p.declining)}</div>
            </div>
            ${p.risk === 'high' || p.declining ? '<div class="mt-2 small"><i class="fas fa-exclamation-triangle me-1"></i>Recommended: contact the parent and check in with the student.</div>' : ''}
          </div>
          <h6>Weekly attendance</h6>
          <div class="chart-wrap" style="height:180px"><canvas id="stuChart"></canvas></div>
          <h6 class="mt-3">Classes and AI batch recommendation</h6>
          <div class="table-responsive"><table class="table table-sm">
            <thead><tr><th>Subject</th><th>Teacher</th><th>Attendance</th><th>Average mark</th><th>Recommended batch</th></tr></thead>
            <tbody>${d.classes.map((c) => `<tr><td>${esc(c.subject)}</td><td class="small">${esc(c.teacher || '–')}</td><td>${pct(c.rate)}</td>
              <td>${c.recommendation ? c.recommendation.mark : '–'}</td>
              <td>${c.recommendation ? `<span class="pill ${{ Advanced: 'ok', Standard: 'info', Support: 'warn' }[c.recommendation.batch]}">${c.recommendation.batch}</span>` : '–'}</td></tr>`).join('')}</tbody>
          </table></div>
          <h6>Marks</h6>
          <div class="table-responsive"><table class="table table-sm"><thead><tr><th>Subject</th><th>Term</th><th>Score</th></tr></thead>
            <tbody>${d.marks.map((m) => `<tr><td>${esc(m.subject)}</td><td>${esc(m.term)}</td><td>${m.score}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted">No marks yet</td></tr>'}</tbody></table></div>
          ${teacherClasses.length ? `
          <form class="row g-2 align-items-end" id="markForm">
            <div class="col-sm-4"><label class="form-label small" for="mClass">Class</label><select class="form-select form-select-sm" id="mClass">${App.options(teacherClasses, { label: 'subject' })}</select></div>
            <div class="col-sm-3"><label class="form-label small" for="mTerm">Term</label><select class="form-select form-select-sm" id="mTerm"><option>Term 1</option><option>Term 2</option><option selected>Term 3</option></select></div>
            <div class="col-sm-3"><label class="form-label small" for="mScore">Score (0-100)</label><input type="number" min="0" max="100" class="form-control form-control-sm" id="mScore" required></div>
            <div class="col-sm-2"><button class="btn btn-sm btn-brand w-100">Save mark</button></div>
          </form>` : ''}
          ${d.payments.length ? `<h6 class="mt-3">Payments</h6><div class="small">${d.payments.map((x) => `<span class="pill ok me-1 mb-1">${App.fmtMonth(x.month)}: ${App.money(x.amount)}</span>`).join('')}</div>` : ''}
        </div>
      </div>`;
    viewModal.show();
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('stuChart'), {
      type: 'bar',
      data: { labels: d.weekly.map((w) => App.fmtDate(w.start)), datasets: [{ data: d.weekly.map((w) => Math.round(w.rate * 100)), backgroundColor: d.weekly.map((w) => (w.rate < 0.6 ? '#ef9a9a' : '#9fa8da')) }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } } },
    });
    const mf = document.getElementById('markForm');
    if (mf) mf.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await App.api(`/students/${id}/marks`, { method: 'POST', body: { classId: Number(f('mClass').value), term: f('mTerm').value, score: Number(f('mScore').value) } });
        App.toast('Mark saved', 'success');
        view(id);
      } catch (ex) { App.toast(ex.message, 'error'); }
    };
  }

  await load();
  const qs = new URLSearchParams(location.search);
  if (qs.get('id')) view(Number(qs.get('id')));
  if (qs.get('new') && admin) edit(null);
})();
