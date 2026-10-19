(async function () {
  const user = await App.init({ page: 'dashboard' });
  const { esc, pct, money, hour } = App;
  const el = document.getElementById('dashboard');
  const d = await App.api('/dashboard');
  document.getElementById('pageSubtitle').textContent = `Welcome back, ${user.name}! Today is ${d.day}, ${App.fmtDate(d.today)}.`;

  const stat = (icon, color, value, label, note = '') => `
    <div class="col-6 col-lg-3"><div class="stat-card">
      <div class="stat-icon ${color}"><i class="fas ${icon}"></i></div>
      <h3>${value}</h3><p class="text-muted mb-0">${label}</p>${note ? `<small>${note}</small>` : ''}
    </div></div>`;

  const sessionItem = (s) => `
    <div class="list-row d-flex justify-content-between align-items-center">
      <div><strong>${esc(s.subject)} - Grade ${s.grade}</strong>
        <div class="text-muted small">${esc(s.teacher || '')} | ${esc(s.room)}</div></div>
      <span class="pill info">${hour(s.hour)}</span>
    </div>`;

  const notesCard = (notes) => `
    <div class="card-box"><h5><i class="far fa-bell me-2"></i>Latest notifications</h5>
      ${notes.length ? notes.map((n) => `<div class="mb-3"><strong>${esc(n.title)}</strong> <small class="text-muted">${App.timeAgo(n.created_at)}</small>
        <div class="small text-muted">${esc(n.body)}</div></div>`).join('') : '<div class="empty">Nothing new</div>'}
      <a href="notifications.html" class="small">All notifications</a></div>`;

  const riskCard = (list, title) => `
    <div class="card-box"><h5><i class="fas fa-brain me-2 text-danger"></i>${title}</h5>
      ${list.length ? list.map((p) => `
        <div class="d-flex align-items-center gap-2 mb-2">
          <span class="avatar sm">${esc(App.initials(p.name))}</span>
          <div class="flex-grow-1"><a href="students.html?id=${p.id}"><strong>${esc(p.name)}</strong></a>
            <div class="small text-muted">Grade ${p.grade} · attended ${pct(p.rate)} · next class ${pct(p.probability)} likely</div></div>
          ${App.riskPill(p.probability < 0.6 ? 'high' : 'medium', p.declining)}
        </div>`).join('') : '<div class="empty">No students need attention right now</div>'}
    </div>`;

  if (d.role === 'student') {
    const p = d.prediction;
    el.innerHTML = `
      <div class="row g-4 mb-4">
        ${stat('fa-calendar-check', 'blue', d.classesPerWeek, 'Classes per week')}
        ${stat('fa-clipboard-check', 'green', pct(p.rate), 'My attendance', p.declining ? '<span class="text-danger">Falling recently</span>' : '<span class="text-success">Keep it up</span>')}
        ${stat('fa-brain', 'purple', pct(p.probability), 'Predicted attendance', 'From the AI model')}
        ${stat('fa-money-bill-wave', 'orange', d.fees.paid ? 'Paid' : money(d.fees.fee), `Fees for ${App.fmtMonth(d.fees.month)}`, d.fees.paid ? `Receipt ${esc(d.fees.receipt)}` : '<span class="text-danger">Due</span>')}
      </div>
      <div class="row">
        <div class="col-lg-7"><div class="card-box"><h5>My next classes</h5>
          ${d.upcoming.length ? d.upcoming.map((s) => `
            <div class="list-row d-flex justify-content-between align-items-center"><div><strong>${esc(s.subject)}</strong>
              <div class="small text-muted">${esc(s.teacher)} | ${esc(s.room)}</div></div>
              <span class="pill info">${App.DAYS[s.day]} ${hour(s.hour)}</span></div>`).join('') : '<div class="empty">No classes scheduled</div>'}
          <a href="schedule.html" class="small">Full timetable</a></div></div>
        <div class="col-lg-5">${notesCard(d.notifications)}</div>
      </div>`;
    return;
  }

  const s = d.stats;
  const stats = d.role === 'teacher'
    ? stat('fa-book', 'blue', s.classes, 'My classes') + stat('fa-user-graduate', 'green', s.students, 'My students')
      + stat('fa-calendar-check', 'orange', s.sessionsPerWeek, 'Sessions per week') + stat('fa-clipboard-check', 'purple', pct(s.attendance), 'Attendance in my classes')
    : stat('fa-user-graduate', 'blue', s.students, 'Active students', `<span class="text-success"><i class="fas fa-user-plus"></i> ${s.newStudents} joined this month</span>`)
      + stat('fa-chalkboard-teacher', 'green', s.teachers, 'Active teachers', `${s.sessionsPerWeek} classes a week`)
      + stat('fa-clipboard-check', 'orange', pct(s.attendance), 'Attendance (4 weeks)', s.highRisk ? `<span class="text-danger">${s.highRisk} students at high risk</span>` : '')
      + stat('fa-money-bill-wave', 'purple', money(s.revenue), 'Collected this month', `${pct(s.revenueExpected ? s.revenue / s.revenueExpected : 0)} of ${money(s.revenueExpected)} · ${s.unpaid} unpaid`);

  el.innerHTML = `
    <div class="row g-4 mb-4">${stats}</div>
    <div class="row">
      <div class="col-lg-8"><div class="card-box"><h5>Attendance trend (last 8 weeks)</h5><div class="chart-wrap"><canvas id="trend"></canvas></div></div></div>
      <div class="col-lg-4"><div class="card-box"><h5>Today's classes <span class="pill muted">${d.todays.length}</span></h5>
        <div style="max-height: 300px; overflow-y: auto">${d.todays.length ? d.todays.map(sessionItem).join('') : '<div class="empty">No classes today</div>'}</div></div></div>
    </div>
    <div class="row">
      <div class="col-lg-6">${riskCard(d.atRisk, d.role === 'teacher' ? 'Students in my classes who need attention' : 'Students who need attention')}</div>
      <div class="col-lg-6">${notesCard(d.notifications)}</div>
    </div>
    ${d.role !== 'teacher' ? `
    <div class="card-box"><h5>Quick actions</h5><div class="row g-2">
      ${user.role === 'admin' ? '<div class="col-6 col-md-3"><a class="btn btn-primary w-100" href="students.html?new=1"><i class="fas fa-plus me-2"></i>Add student</a></div>' : ''}
      <div class="col-6 col-md-3"><a class="btn btn-success w-100" href="schedule.html"><i class="fas fa-calendar-plus me-2"></i>Create schedule</a></div>
      <div class="col-6 col-md-3"><a class="btn btn-warning w-100" href="reports.html"><i class="fas fa-file-invoice me-2"></i>Reports</a></div>
      <div class="col-6 col-md-3"><a class="btn btn-info w-100" href="notifications.html?compose=1"><i class="fas fa-bell me-2"></i>Send notification</a></div>
    </div></div>` : `
    <div class="card-box"><h5>Quick actions</h5><div class="row g-2">
      <div class="col-6 col-md-4"><a class="btn btn-primary w-100" href="attendance.html"><i class="fas fa-clipboard-check me-2"></i>Mark attendance</a></div>
      <div class="col-6 col-md-4"><a class="btn btn-success w-100" href="schedule.html"><i class="fas fa-calendar-alt me-2"></i>My timetable</a></div>
      <div class="col-12 col-md-4"><a class="btn btn-info w-100" href="account.html"><i class="fas fa-clock me-2"></i>Update availability</a></div>
    </div></div>`}`;

  new Chart(document.getElementById('trend'), {
    type: 'line',
    data: {
      labels: d.trend.map((w) => App.fmtDate(w.start)),
      datasets: [{ label: 'Attendance rate (%)', data: d.trend.map((w) => Math.round(w.rate * 1000) / 10), borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,.12)', tension: 0.35, fill: true }],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 50, max: 100, ticks: { callback: (v) => v + '%' } } } },
  });
})();
