(async function () {
  const user = await App.init({ page: 'attendance' });
  const { esc, pct, hour } = App;
  const f = (id) => document.getElementById(id);

  if (user.role === 'student') return studentView(user);
  f('staffView').classList.remove('d-none');
  const staff = user.role !== 'teacher';
  document.querySelectorAll('.staff-only').forEach((x) => x.classList.toggle('d-none', !staff));
  if (!staff) document.querySelector('.branch-filter').classList.add('d-none');
  const meta = await App.api('/meta');
  f('branch').innerHTML += App.options(meta.branches);
  f('date').value = App.localDate();
  f('date').max = App.localDate();

  let sessions = [], current = null, state = new Map();

  async function loadSessions() {
    const d = await App.api(`/attendance/sessions?date=${f('date').value}${f('branch').value ? '&branch=' + f('branch').value : ''}`);
    sessions = d.sessions;
    f('noClasses').classList.toggle('d-none', sessions.length > 0);
    f('classPanel').classList.toggle('d-none', sessions.length === 0);
    f('session').innerHTML = sessions.map((s) => `<option value="${s.class_id}">${hour(s.hour)} · ${esc(s.subject)} - Grade ${s.grade} · ${esc(s.teacher)} · ${esc(s.room)}${s.marked ? ' ✓ marked' : ''}</option>`).join('')
      || '<option>No classes on this day</option>';
    if (sessions.length) loadClass();
  }

  async function loadClass() {
    const classId = Number(f('session').value);
    const s = sessions.find((x) => x.class_id === classId);
    const d = await App.api(`/attendance/class/${classId}?date=${f('date').value}`);
    current = { ...d, session: s };
    state = new Map(d.students.map((st) => [st.id, st.status]));
    f('classTitle').textContent = `${d.class.subject} - Grade ${d.class.grade}`;
    f('classMeta').textContent = `${d.class.teacher} · ${s.room} · ${App.DAYS[s.day]} ${hour(s.hour)} · ${App.fmtDate(d.date)}`;
    f('turnout').innerHTML = d.turnout ? `<span class="pill info"><i class="fas fa-brain me-1"></i>AI expects ${d.turnout.expected} of ${d.turnout.enrolled} (${pct(d.turnout.rate)})</span>` : '';
    renderStudents();
  }

  function renderStudents() {
    const list = current.students;
    f('studentList').innerHTML = list.map((st) => `
      <div class="att-row" data-id="${st.id}">
        <div class="d-flex align-items-center gap-2">
          <span class="avatar sm">${esc(App.initials(st.name))}</span>
          <div><strong>${esc(st.name)}</strong> ${st.risk === 'high' || st.declining ? App.riskPill(st.risk, st.declining) : ''}<br>
            <small class="text-muted">${esc(st.code)} · Avg ${pct(st.rate)}${st.probability !== null ? ` · AI: ${pct(st.probability)} likely` : ''}</small></div>
        </div>
        <div class="att-buttons btn-group" role="group" aria-label="Status for ${esc(st.name)}">
          ${[['present', 'success', 'fa-check', 'Present'], ['absent', 'danger', 'fa-times', 'Absent'], ['late', 'warning', 'fa-clock', 'Late']].map(([v, c, i, l]) => `
            <button type="button" class="btn btn-outline-${c} ${state.get(st.id) === v ? 'active' : ''}" data-status="${v}"><i class="fas ${i} me-1"></i>${l}</button>`).join('')}
        </div>
      </div>`).join('') || '<div class="empty">No students are enrolled in this class</div>';
    counts();
  }

  function counts() {
    const v = [...state.values()];
    f('cPresent').textContent = v.filter((x) => x === 'present').length;
    f('cAbsent').textContent = v.filter((x) => x === 'absent').length;
    f('cLate').textContent = v.filter((x) => x === 'late').length;
    f('cTotal').textContent = current.students.length;
  }

  f('studentList').onclick = (e) => {
    const b = e.target.closest('[data-status]'); if (!b) return;
    const row = b.closest('[data-id]');
    state.set(Number(row.dataset.id), b.dataset.status);
    row.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
    counts();
  };
  f('allPresentBtn').onclick = () => { current.students.forEach((s) => state.set(s.id, 'present')); renderStudents(); };
  f('resetBtn').onclick = () => { current.students.forEach((s) => state.set(s.id, null)); renderStudents(); };
  f('saveBtn').onclick = async () => {
    const records = [...state].filter(([, v]) => v).map(([studentId, status]) => ({ studentId, status }));
    if (!records.length) return App.toast('Mark attendance for at least one student', 'error');
    try {
      const r = await App.api('/attendance', { method: 'POST', body: { classId: current.class.id, date: current.date, records } });
      App.toast(`Saved ${r.saved} records. ${r.parentsNotified ? `${r.parentsNotified} parent${r.parentsNotified === 1 ? " was" : "s were"} sent an absence message.` : "No new absences."}`, 'success');
      const opt = f('session').selectedOptions[0];
      if (opt && !opt.textContent.includes('✓')) opt.textContent += ' ✓ marked';
      loadInsights();
    } catch (ex) { App.toast(ex.message, 'error'); }
  };
  f('date').onchange = loadSessions;
  f('branch').onchange = loadSessions;
  f('session').onchange = loadClass;
  f('exportBtn').onclick = () => App.download('/attendance/export.csv' + (current ? `?classId=${current.class.id}` : ''));

  async function loadInsights() {
    const d = await App.api('/attendance/insights');
    const days = d.weekday.filter((x) => x.rate !== null);
    const worst = days.reduce((a, b) => (b.rate < a.rate ? b : a), days[0]);
    const m = d.model;
    f('insights').innerHTML = `
      <div class="col-md-6">
        <div class="alert alert-warning mb-2"><i class="fas fa-exclamation-triangle me-2"></i><strong>Needs attention:</strong>
          ${d.atRisk.length ? d.atRisk.slice(0, 4).map((p) => `<a class="alert-link" href="students.html?id=${p.id}">${esc(p.name)}</a> (${pct(p.recentRate ?? p.rate)}${p.declining ? ', falling' : ''})`).join(', ') + '. Recommend contacting their parents.' : 'no students right now.'}</div>
        ${worst ? `<div class="alert alert-info mb-2"><i class="fas fa-chart-line me-2"></i><strong>Pattern:</strong> ${worst.day} classes have the lowest attendance (${pct(worst.rate)} vs ${pct(d.overall)} overall, last 8 weeks).</div>` : ''}
      </div>
      <div class="col-md-6">
        <div class="alert alert-success mb-2"><i class="fas fa-check-circle me-2"></i><strong>High performers:</strong> ${d.highPerformers} students attend 95% or more of their classes.</div>
        <div class="alert alert-primary mb-2"><i class="fas fa-robot me-2"></i><strong>Model:</strong> ${m ? `logistic regression trained on ${m.trainSamples.toLocaleString()} records, ${pct(m.accuracy, 1)} accurate on the most recent ${m.testSamples.toLocaleString()} (always guessing "present" would be ${pct(m.baselineAccuracy, 1)}).` : 'not enough attendance history yet.'}</div>
      </div>`;
  }

  loadSessions();
  loadInsights();

  // Students and parents see their own record.
  async function studentView() {
    const { esc, pct } = App;
    document.getElementById('studentView').classList.remove('d-none');
    document.getElementById('pageTitle').textContent = 'My Attendance';
    document.getElementById('pageSubtitle').textContent = 'Your attendance record and AI prediction';
    const d = await App.api('/attendance/student/' + user.studentId);
    const p = d.prediction;
    const tile = (icon, color, v, label) => `<div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon ${color}"><i class="fas ${icon}"></i></div><h3>${v}</h3><p class="text-muted mb-0">${label}</p></div></div>`;
    document.getElementById('myStats').innerHTML = tile('fa-clipboard-check', 'green', pct(p.rate), 'Attended overall')
      + tile('fa-calendar-week', 'blue', pct(p.recentRate), 'Recent weeks')
      + tile('fa-brain', 'purple', pct(p.probability), 'AI prediction for next class')
      + tile('fa-flag', 'orange', App.riskPill(p.risk, p.declining), 'Status');
    document.getElementById('bySubject').innerHTML = d.bySubject.map((s) => {
      const rate = (s.present + s.late) / s.sessions;
      return `<div class="mb-3"><div class="d-flex justify-content-between"><strong>${esc(s.subject)}</strong><span>${pct(rate)}</span></div>
        <div class="progress" style="height:8px"><div class="progress-bar ${rate < 0.75 ? 'bg-danger' : 'bg-success'}" style="width:${rate * 100}%"></div></div>
        <small class="text-muted">${s.present} present · ${s.late} late · ${s.absent} absent</small></div>`;
    }).join('') || '<div class="empty">No records yet</div>';
    const pill = { present: 'ok', late: 'warn', absent: 'bad' };
    document.getElementById('history').innerHTML = d.records.map((r) => `<tr><td>${App.fmtDate(r.date)}</td><td>${esc(r.subject)}</td><td><span class="pill ${pill[r.status]}">${r.status}</span></td></tr>`).join('');
  }
})();
