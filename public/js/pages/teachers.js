(async function () {
  const user = await App.init({ page: 'teachers', roles: ['admin', 'coordinator'] });
  const { esc, DAYS } = App;
  const admin = user.role === 'admin';
  const meta = await App.api('/meta');
  const f = (id) => document.getElementById(id);
  let teachers = [], classes = [];

  document.querySelectorAll('.admin-only').forEach((x) => x.classList.toggle('d-none', !admin));
  f('tBranch').innerHTML += App.options(meta.branches);
  f('cBranch').innerHTML = App.options(meta.branches);
  f('tBranchSel').innerHTML = App.options(meta.branches);
  f('cBranchSel').innerHTML = App.options(meta.branches);
  f('cSubject').innerHTML = meta.subjects.map((s) => `<option>${esc(s)}</option>`).join('');
  f('cGrade').innerHTML = meta.grades.map((g) => `<option value="${g}">Grade ${g}</option>`).join('');
  f('tSubjects').innerHTML = meta.subjects.map((s, i) => `<div class="form-check"><input class="form-check-input" type="checkbox" id="ts${i}" value="${esc(s)}"><label class="form-check-label" for="ts${i}">${esc(s)}</label></div>`).join('');
  f('tDays').innerHTML = DAYS.map((d, i) => `<div class="form-check"><input class="form-check-input" type="checkbox" id="td${i}" value="${i}"><label class="form-check-label" for="td${i}">${d.slice(0, 3)}</label></div>`).join('');

  async function loadTeachers() {
    teachers = (await App.api('/teachers')).teachers;
    renderTeachers();
  }

  function renderTeachers() {
    const q = f('tq').value.trim().toLowerCase(), b = f('tBranch').value;
    const list = teachers.filter((t) => (!q || t.name.toLowerCase().includes(q) || t.subjects.join(' ').toLowerCase().includes(q)) && (!b || String(t.branch_id) === b));
    f('tRows').innerHTML = list.map((t) => `
      <tr>
        <td><div class="d-flex align-items-center gap-2"><span class="avatar sm">${esc(App.initials(t.name))}</span>
          <div><strong>${esc(t.name)}</strong>${t.active ? '' : ' <span class="pill muted">inactive</span>'}<br><small class="text-muted">${esc(t.branch.split(' - ').pop())} · ${esc(t.email || '')}</small></div></div></td>
        <td class="small">${t.subjects.map(esc).join(', ')}</td>
        <td>${DAYS.map((d, i) => `<span class="pill ${t.available_days.includes(i) ? 'ok' : 'muted'} me-1 mb-1" title="${d}">${d.slice(0, 2)}</span>`).join('')}</td>
        <td class="small">${t.classes.map((c) => `${esc(c.subject)} G${c.grade}`).join(', ') || '–'}</td>
        <td><strong>${t.weeklySessions}</strong> classes<br><small class="text-muted">${t.weeklyHours} h / week</small></td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-warning" data-edit="${t.id}" aria-label="Edit"><i class="fas fa-edit"></i></button>
          ${admin ? `<button class="btn btn-sm btn-outline-danger" data-del="${t.id}" aria-label="Delete"><i class="fas fa-trash"></i></button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">No teachers found</td></tr>';
  }
  f('tq').oninput = renderTeachers;
  f('tBranch').onchange = renderTeachers;

  const tModal = new bootstrap.Modal(f('teacherModal'));
  let editingT = null;
  function openTeacher(t) {
    editingT = t ? t.id : null;
    f('teacherForm').reset();
    f('teacherError').classList.add('d-none');
    f('teacherTitle').textContent = t ? 'Edit teacher' : 'Add teacher';
    document.querySelectorAll('.new-only').forEach((x) => x.classList.toggle('d-none', !!t));
    f('tName').value = t?.name || ''; f('tEmail').value = t?.email || ''; f('tPhone').value = t?.phone || '';
    f('tBranchSel').value = t?.branch_id || meta.branches[0].id; f('tMax').value = t?.max_per_day || 4; f('tActive').checked = t ? !!t.active : true;
    f('tName').disabled = !admin && !!t;
    document.querySelectorAll('#tSubjects input').forEach((x) => { x.checked = !!t && t.subjects.includes(x.value); });
    document.querySelectorAll('#tDays input').forEach((x) => { x.checked = t ? t.available_days.includes(Number(x.value)) : true; });
    tModal.show();
  }
  f('addTeacher').onclick = () => openTeacher(null);
  f('tRows').onclick = async (e) => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) openTeacher(teachers.find((t) => t.id === Number(ed.dataset.edit)));
    if (del) {
      const t = teachers.find((x) => x.id === Number(del.dataset.del));
      if (await App.confirm(`Delete ${t.name}? Their classes will have no teacher until you assign one.`, { ok: 'Delete', danger: true })) {
        await App.api('/teachers/' + t.id, { method: 'DELETE' });
        App.toast('Teacher deleted', 'success');
        loadTeachers(); loadClasses();
      }
    }
  };
  f('teacherForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: f('tName').value, email: f('tEmail').value, phone: f('tPhone').value, branch_id: Number(f('tBranchSel').value),
      max_per_day: Number(f('tMax').value), active: f('tActive').checked,
      subjects: [...document.querySelectorAll('#tSubjects input:checked')].map((x) => x.value),
      available_days: [...document.querySelectorAll('#tDays input:checked')].map((x) => Number(x.value)),
    };
    if (!editingT && f('tUser').value) { body.username = f('tUser').value; body.password = f('tPass').value; }
    try {
      await App.api(editingT ? '/teachers/' + editingT : '/teachers', { method: editingT ? 'PUT' : 'POST', body });
      tModal.hide();
      App.toast('Teacher saved', 'success');
      loadTeachers();
    } catch (ex) { f('teacherError').textContent = ex.message; f('teacherError').classList.remove('d-none'); }
  });

  // ---------- classes
  async function loadClasses() {
    classes = (await App.api('/classes?branch=' + f('cBranch').value)).classes;
    f('cRows').innerHTML = classes.map((c) => `
      <tr>
        <td><strong>${esc(c.subject)}</strong> <span class="pill info">Grade ${c.grade}</span></td>
        <td>${c.teacher ? esc(c.teacher) : '<span class="pill bad">No teacher</span>'}</td>
        <td>${c.size}</td>
        <td>${App.money(c.monthly_fee)}</td>
        <td>${c.needs_lab ? '<span class="pill warn"><i class="fas fa-flask"></i> Lab</span>' : '–'}</td>
        <td class="text-capitalize">${esc(c.preference)}</td>
        <td class="text-end text-nowrap"><button class="btn btn-sm btn-outline-warning" data-edit="${c.id}" aria-label="Edit"><i class="fas fa-edit"></i></button>
          ${admin ? `<button class="btn btn-sm btn-outline-danger" data-del="${c.id}" aria-label="Delete"><i class="fas fa-trash"></i></button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">No classes</td></tr>';
  }
  f('cBranch').onchange = loadClasses;

  const cModal = new bootstrap.Modal(f('classModal'));
  let editingC = null;
  function teacherOptions(selected) {
    const branch = Number(f('cBranchSel').value), subject = f('cSubject').value;
    const list = teachers.filter((t) => t.branch_id === branch).sort((a, b) => (b.subjects.includes(subject) - a.subjects.includes(subject)) || a.name.localeCompare(b.name));
    f('cTeacher').innerHTML = App.options(list, { label: (t) => `${t.name}${t.subjects.includes(subject) ? '' : ' (other subject)'}`, selected, blank: 'No teacher yet' });
  }
  f('cBranchSel').onchange = () => teacherOptions();
  f('cSubject').onchange = () => teacherOptions(f('cTeacher').value);
  function openClass(c) {
    editingC = c ? c.id : null;
    f('classError').classList.add('d-none');
    f('classTitle').textContent = c ? 'Edit class' : 'Add class';
    f('cSubject').value = c?.subject || meta.subjects[0]; f('cGrade').value = c?.grade || 10;
    f('cBranchSel').value = c?.branch_id || f('cBranch').value; f('cFee').value = c?.monthly_fee ?? 2500;
    f('cPref').value = c?.preference || 'any'; f('cLab').checked = !!c?.needs_lab;
    teacherOptions(c?.teacher_id);
    cModal.show();
  }
  f('addClass').onclick = () => openClass(null);
  f('cRows').onclick = async (e) => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) openClass(classes.find((c) => c.id === Number(ed.dataset.edit)));
    if (del) {
      const c = classes.find((x) => x.id === Number(del.dataset.del));
      if (await App.confirm(`Delete ${c.subject} Grade ${c.grade}? Its enrolments, attendance and timetable sessions will be removed.`, { ok: 'Delete', danger: true })) {
        await App.api('/classes/' + c.id, { method: 'DELETE' });
        App.toast('Class deleted', 'success');
        loadClasses();
      }
    }
  };
  f('classForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      subject: f('cSubject').value, grade: Number(f('cGrade').value), branch_id: Number(f('cBranchSel').value),
      teacher_id: f('cTeacher').value ? Number(f('cTeacher').value) : null, monthly_fee: Number(f('cFee').value),
      preference: f('cPref').value, needs_lab: f('cLab').checked,
    };
    try {
      await App.api(editingC ? '/classes/' + editingC : '/classes', { method: editingC ? 'PUT' : 'POST', body });
      cModal.hide();
      App.toast('Class saved', 'success');
      f('cBranch').value = body.branch_id;
      loadClasses(); loadTeachers();
    } catch (ex) { f('classError').textContent = ex.message; f('classError').classList.remove('d-none'); }
  });

  await loadTeachers();
  loadClasses();
})();
