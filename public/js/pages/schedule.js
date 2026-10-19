(async function () {
  const user = await App.init({ page: 'schedule' });
  const { esc, hour, DAYS } = App;
  const staff = user.role === 'admin' || user.role === 'coordinator';
  const meta = await App.api('/meta');
  let current = [];          // sessions shown in the grid
  let preview = null;        // generated timetable waiting to be published
  let lunchBreak = true;

  document.querySelectorAll('.staff-only').forEach((x) => x.classList.toggle('d-none', !staff));
  if (!staff) {
    document.getElementById('pageTitle').textContent = user.role === 'teacher' ? 'My Teaching Timetable' : 'My Class Timetable';
    document.getElementById('pageSubtitle').textContent = 'Your weekly classes from the published timetable';
    document.getElementById('viewBranch').classList.add('d-none');
  }

  const branchOpts = App.options(meta.branches);
  document.getElementById('branch').innerHTML = branchOpts;
  document.getElementById('viewBranch').innerHTML = branchOpts;
  document.getElementById('gradeFilter').innerHTML += meta.grades.map((g) => `<option value="${g}">Grade ${g}</option>`).join('');
  document.getElementById('grades').innerHTML = meta.grades.map((g) => `
    <div class="form-check form-check-inline me-0"><input class="form-check-input" type="checkbox" id="g${g}" value="${g}" checked>
    <label class="form-check-label" for="g${g}">${g}</label></div>`).join('');

  const allHours = [...new Set(Object.values(meta.dayHours).flat())].sort((a, b) => a - b);

  function renderGrid(sessions, { editable = false } = {}) {
    const grade = document.getElementById('gradeFilter').value;
    const list = sessions.filter((s) => !grade || String(s.grade) === grade);
    const cell = (day, h) => {
      if (!meta.dayHours[day].includes(h)) return '<td class="off"></td>';
      if (h === meta.lunchHour && lunchBreak) return '<td class="text-center small text-muted" style="background:#fffde7"><i class="fas fa-utensils me-1"></i>Lunch</td>';
      const here = list.filter((s) => s.day === day && s.hour === h);
      return `<td>${here.map((s) => `
        <div class="class-slot ${App.subjClass(s.subject)} ${editable && s.id ? 'editable' : ''}" ${s.id ? `data-id="${s.id}"` : ''} title="${esc(s.teacher)} · ${esc(s.room)} · ${s.size ?? ''} students">
          <strong>${esc(s.subject)} G${s.grade}</strong><br>${esc(s.teacher || '')}<br>${esc(s.room)}${s.fixed ? ' <i class="fas fa-lock" title="Kept as it was"></i>' : ''}
        </div>`).join('')}</td>`;
    };
    document.getElementById('timetable').innerHTML = list.length || sessions.length ? `
      <table class="table table-bordered mb-0">
        <thead><tr><th style="width:90px">Time</th>${DAYS.map((d) => `<th>${d}</th>`).join('')}</tr></thead>
        <tbody>${allHours.map((h) => `<tr><td class="time">${hour(h)}</td>${DAYS.map((_, day) => cell(day, h)).join('')}</tr>`).join('')}</tbody>
      </table>` : '<div class="empty">No classes in the published timetable yet.</div>';
    if (editable) document.querySelectorAll('.class-slot.editable').forEach((el) => { el.onclick = () => openMove(Number(el.dataset.id)); });
  }

  async function loadActive() {
    const branch = document.getElementById('viewBranch').value;
    const data = await App.api('/schedule' + (staff ? `?branch=${branch}` : ''));
    current = data.sessions;
    const tt = data.timetables.find((t) => !staff || String(t.branch_id) === branch);
    lunchBreak = tt ? tt.settings.lunchBreak : true;
    document.getElementById('ttTitle').innerHTML = '<i class="fas fa-table me-2"></i>Published timetable';
    document.getElementById('ttMeta').innerHTML = tt && staff
      ? `Week ${esc(tt.week)} · priority: ${esc(tt.priority)} · optimisation score <strong>${tt.score}</strong> · published ${App.timeAgo(tt.created_at)} by ${esc(tt.created_by || 'system')}`
      : `${current.length} classes a week`;
    renderGrid(current, { editable: staff });
  }

  // ---------- generate and publish (staff)
  function weekNow() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const w1 = new Date(d.getFullYear(), 0, 4);
    const n = 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
    return `${d.getFullYear()}-W${String(n).padStart(2, '0')}`;
  }
  document.getElementById('week').value = weekNow();

  function showPreview(p, kind) {
    preview = p;
    const parts = p.parts ? Object.entries({ 'Classes placed': p.parts.placed, 'Preference met': p.parts.preference, 'Seats used': p.parts.roomUtilization, 'Workload spread': p.parts.workloadBalance })
      .map(([k, v]) => `<span class="pill muted me-1">${k}: ${App.pct(v)}</span>`).join('') : '';
    const box = document.getElementById('preview');
    box.classList.remove('d-none');
    box.innerHTML = `
      <div class="alert ${p.unplaced.length || p.conflicts.length ? 'alert-warning' : 'alert-success'}">
        <div class="d-flex justify-content-between flex-wrap gap-2">
          <div>
            <strong><i class="fas ${p.unplaced.length ? 'fa-exclamation-triangle' : 'fa-check-circle'} me-2"></i>${kind} ready to review</strong><br>
            ${p.assignments.length} classes placed in ${p.ms} ms · ${p.conflicts.length} conflicts · ${p.unplaced.length} could not be placed
            ${p.kept ? ` · ${p.kept} kept as they were` : ''}${p.moved !== undefined ? ` · ${p.moved} re-placed` : ''}
            <span class="badge bg-success ms-1">${p.score} optimisation score</span>
            <div class="mt-2">${parts}</div>
          </div>
          <div class="d-flex gap-2 align-items-start">
            <button class="btn btn-success" id="publishBtn"><i class="fas fa-upload me-1"></i>Publish</button>
            <button class="btn btn-outline-secondary" id="discardBtn">Discard</button>
          </div>
        </div>
        ${p.unplaced.length ? `<hr><ul class="mb-0">${p.unplaced.map((u) => `<li><strong>${esc(u.subject)} Grade ${u.grade}</strong> (${esc(u.teacher || 'no teacher')}): ${esc(u.message)}</li>`).join('')}</ul>` : ''}
      </div>`;
    document.getElementById('ttTitle').innerHTML = '<i class="fas fa-eye me-2"></i>Preview (not published yet)';
    document.getElementById('ttMeta').textContent = `Week ${p.week} · priority: ${p.settings.priority}`;
    lunchBreak = p.settings.lunchBreak;
    renderGrid(p.assignments.map((a) => ({ ...a, id: null })));
    document.getElementById('publishBtn').onclick = publish;
    document.getElementById('discardBtn').onclick = () => { preview = null; box.classList.add('d-none'); loadActive(); };
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('genForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('genBtn');
    const grades = [...document.querySelectorAll('#grades input:checked')].map((x) => Number(x.value));
    if (!grades.length) return App.toast('Choose at least one grade', 'error');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Solving constraints...';
    try {
      const branchId = Number(document.getElementById('branch').value);
      document.getElementById('viewBranch').value = branchId;
      const p = await App.api('/schedule/generate', {
        method: 'POST',
        body: {
          branchId, grades, week: document.getElementById('week').value,
          priority: document.getElementById('priority').value,
          maxPerDay: Number(document.getElementById('maxPerDay').value),
          noBackToBack: document.getElementById('noBackToBack').checked,
          lunchBreak: document.getElementById('lunchBreak').checked,
        },
      });
      showPreview(p, 'New timetable');
    } catch (ex) { App.toast(ex.message, 'error'); }
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magic me-2"></i>Generate schedule with AI';
  });

  document.getElementById('rescheduleBtn').addEventListener('click', async () => {
    try {
      const p = await App.api('/schedule/reschedule', { method: 'POST', body: { branchId: Number(document.getElementById('branch').value) } });
      document.getElementById('viewBranch').value = document.getElementById('branch').value;
      if (!p.moved && !p.unplaced.length) App.toast('Every class still fits. Nothing needs to move.', 'success');
      showPreview(p, 'Rescheduled timetable');
    } catch (ex) { App.toast(ex.message, 'error'); }
  });

  async function publish() {
    if (!preview) return;
    const ok = await App.confirm('Publish this timetable? Teachers and students whose classes move will be notified.', { ok: 'Publish' });
    if (!ok) return;
    try {
      const r = await App.api('/schedule/publish', { method: 'POST', body: { previewId: preview.previewId } });
      App.toast(r.changed ? `Timetable published. ${r.changed} classes moved and their teachers and students were notified.` : 'Timetable published. No classes moved.', 'success');
      preview = null;
      document.getElementById('preview').classList.add('d-none');
      loadActive();
    } catch (ex) { App.toast(ex.message, 'error'); }
  }

  // ---------- move a class (staff)
  const moveModal = new bootstrap.Modal(document.getElementById('moveModal'));
  let moving = null;
  document.getElementById('moveDay').innerHTML = DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('');
  function fillHours() {
    const day = Number(document.getElementById('moveDay').value);
    document.getElementById('moveHour').innerHTML = meta.dayHours[day].map((h) => `<option value="${h}">${hour(h)}</option>`).join('');
  }
  document.getElementById('moveDay').onchange = () => { fillHours(); document.getElementById('moveResult').innerHTML = ''; };
  ['moveHour', 'moveRoom'].forEach((id) => { document.getElementById(id).onchange = () => { document.getElementById('moveResult').innerHTML = ''; }; });

  function openMove(id) {
    moving = current.find((s) => s.id === id);
    if (!moving) return;
    document.getElementById('moveInfo').innerHTML = `<strong>${esc(moving.subject)} Grade ${moving.grade}</strong> with ${esc(moving.teacher)}, ${moving.size} students.<br>
      <span class="text-muted">Now: ${DAYS[moving.day]} ${hour(moving.hour)} in ${esc(moving.room)}</span>`;
    document.getElementById('moveDay').value = moving.day;
    fillHours();
    document.getElementById('moveHour').value = moving.hour;
    const rooms = meta.rooms.filter((r) => r.branch_id === moving.branch_id);
    document.getElementById('moveRoom').innerHTML = App.options(rooms, { label: (r) => `${r.name} (${r.capacity} seats${r.is_lab ? ', lab' : ''})`, selected: moving.room_id });
    document.getElementById('moveResult').innerHTML = '';
    moveModal.show();
  }
  const moveBody = () => ({ day: Number(document.getElementById('moveDay').value), hour: Number(document.getElementById('moveHour').value), roomId: Number(document.getElementById('moveRoom').value) });
  const showIssues = (r) => {
    document.getElementById('moveResult').innerHTML = r.ok
      ? '<div class="alert alert-success mb-0"><i class="fas fa-check-circle me-1"></i>This move keeps every rule.</div>'
      : `<div class="alert alert-danger mb-0"><strong>Not allowed:</strong><ul class="mb-0">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  };
  document.getElementById('moveCheck').onclick = async () => showIssues(await App.api(`/schedule/sessions/${moving.id}/check`, { method: 'POST', body: moveBody() }));
  document.getElementById('moveSave').onclick = async () => {
    try {
      await App.api(`/schedule/sessions/${moving.id}`, { method: 'PUT', body: moveBody() });
      moveModal.hide();
      App.toast('Class moved. The teacher and students were notified.', 'success');
      loadActive();
    } catch (ex) {
      if (ex.data && ex.data.reasons) showIssues({ ok: false, reasons: ex.data.reasons }); else App.toast(ex.message, 'error');
    }
  };

  document.getElementById('viewBranch').onchange = () => { if (!preview) loadActive(); };
  document.getElementById('gradeFilter').onchange = () => (preview ? renderGrid(preview.assignments.map((a) => ({ ...a, id: null }))) : renderGrid(current, { editable: staff }));
  document.getElementById('printBtn').onclick = () => window.print();
  document.getElementById('csvBtn').onclick = () => App.download('/schedule/export.csv' + (staff ? `?branch=${document.getElementById('viewBranch').value}` : ''));

  loadActive();
})();
