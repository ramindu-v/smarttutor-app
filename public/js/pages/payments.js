(async function () {
  const user = await App.init({ page: 'payments', roles: ['admin', 'student'] });
  const { esc, money } = App;
  const admin = user.role === 'admin';
  const f = (id) => document.getElementById(id);
  document.querySelectorAll('.admin-only').forEach((x) => x.classList.toggle('d-none', !admin));
  if (!admin) {
    f('pageTitle').textContent = 'My Fees';
    f('pageSubtitle').textContent = 'Monthly fees and receipts';
  }
  f('month').value = App.localDate().slice(0, 7);
  let dues = null, history = [];

  async function load() {
    const m = f('month').value;
    [dues, history] = await Promise.all([
      App.api('/payments/dues?month=' + m),
      App.api('/payments' + (admin ? '' : '')).then((r) => r.payments),
    ]);
    const s = dues.summary;
    const tile = (icon, color, v, label) => `<div class="col-6 col-lg-3"><div class="stat-card"><div class="stat-icon ${color}"><i class="fas ${icon}"></i></div><h3>${v}</h3><p class="text-muted mb-0">${label}</p></div></div>`;
    f('summary').innerHTML = admin
      ? tile('fa-coins', 'purple', money(s.collected), `Collected for ${App.fmtMonth(m)}`) + tile('fa-bullseye', 'blue', money(s.expected), 'Expected')
        + tile('fa-check', 'green', s.paid, 'Students paid') + tile('fa-exclamation', 'orange', s.unpaid, 'Students unpaid')
      : tile('fa-money-bill', 'purple', money(s.expected), `Fee for ${App.fmtMonth(m)}`) + tile(s.unpaid ? 'fa-exclamation' : 'fa-check', s.unpaid ? 'orange' : 'green', s.unpaid ? 'Due' : 'Paid', 'Status');
    renderDues();
    renderHistory();
  }

  function renderDues() {
    const q = f('dq').value.trim().toLowerCase(), filter = admin ? f('dFilter').value : '';
    const rows = dues.rows.filter((r) => (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      && (!filter || (filter === 'paid') === !!r.payment_id));
    f('dues').innerHTML = rows.slice(0, 300).map((r) => `
      <tr><td><strong>${esc(r.name)}</strong><br><small class="text-muted">${esc(r.code)} · ${esc(r.branch.split(' - ').pop())}</small></td>
        <td>Grade ${r.grade}</td><td>${money(r.fee)}</td>
        <td>${r.payment_id ? `<span class="pill ok">Paid ${App.fmtDate(r.paid_on)}</span>` : '<span class="pill bad">Unpaid</span>'}</td>
        <td class="text-end">${r.payment_id ? `<a class="btn btn-sm btn-outline-primary" href="receipt.html?id=${r.payment_id}" target="_blank"><i class="fas fa-receipt me-1"></i>Receipt</a>`
          : (admin ? `<button class="btn btn-sm btn-success" data-pay="${r.id}"><i class="fas fa-plus me-1"></i>Record</button>` : '<span class="small text-muted">Pay at the front office</span>')}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Nothing to show</td></tr>';
  }

  function renderHistory() {
    const q = f('hq').value.trim().toLowerCase();
    const rows = history.filter((p) => !q || p.student.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || p.receipt_no.toLowerCase().includes(q));
    f('history').innerHTML = rows.slice(0, 300).map((p) => `
      <tr><td><code>${esc(p.receipt_no)}</code></td><td>${esc(p.student)}<br><small class="text-muted">${esc(p.code)}</small></td>
        <td>${App.fmtMonth(p.month)}</td><td>${money(p.amount)}</td><td class="text-capitalize">${esc(p.method)}</td><td>${App.fmtDate(p.paid_on)}</td>
        <td class="text-end text-nowrap"><a class="btn btn-sm btn-outline-primary" href="receipt.html?id=${p.id}" target="_blank" aria-label="Receipt"><i class="fas fa-receipt"></i></a>
        ${admin ? `<button class="btn btn-sm btn-outline-danger" data-void="${p.id}" aria-label="Void"><i class="fas fa-ban"></i></button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">No payments yet</td></tr>';
  }

  f('month').onchange = load;
  f('dq').oninput = renderDues;
  f('dFilter').onchange = renderDues;
  f('hq').oninput = renderHistory;
  f('exportBtn').onclick = () => App.download('/payments/export.csv');
  f('remindBtn').onclick = async () => {
    const m = f('month').value;
    if (!(await App.confirm(`Send a fee reminder for ${App.fmtMonth(m)} to every student who has not paid, and an SMS to their parents?`, { ok: 'Send reminders' }))) return;
    const r = await App.api('/payments/reminders', { method: 'POST', body: { month: m } });
    App.toast(`Reminders sent to ${r.reminded} students (${r.sms} parent SMS queued).`, 'success');
  };
  f('history').onclick = async (e) => {
    const v = e.target.closest('[data-void]'); if (!v) return;
    if (await App.confirm('Void this payment? The student will show as unpaid for that month.', { ok: 'Void payment', danger: true })) {
      await App.api('/payments/' + v.dataset.void, { method: 'DELETE' });
      App.toast('Payment voided', 'success');
      load();
    }
  };

  // ---------- record a payment
  if (!admin) return load();
  const modal = new bootstrap.Modal(f('payModal'));
  const { students } = await App.api('/students?status=active');
  const label = (s) => `${s.code} - ${s.name}`;
  f('studentList').innerHTML = students.map((s) => `<option value="${esc(label(s))}">`).join('');
  const pick = () => students.find((s) => label(s) === f('pStudent').value);
  f('pStudent').onchange = () => {
    const s = pick();
    const row = s && dues.rows.find((r) => r.id === s.id);
    if (row) f('pAmount').value = row.fee;
  };
  function open(studentId) {
    f('payForm').reset();
    f('payError').classList.add('d-none');
    f('pMonth').value = f('month').value;
    const s = students.find((x) => x.id === studentId);
    if (s) { f('pStudent').value = label(s); f('pStudent').onchange(); }
    modal.show();
  }
  f('recordBtn').onclick = () => open(null);
  f('dues').onclick = (e) => { const b = e.target.closest('[data-pay]'); if (b) open(Number(b.dataset.pay)); };
  f('payForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = pick();
    if (!s) { f('payError').textContent = 'Choose a student from the list'; f('payError').classList.remove('d-none'); return; }
    try {
      const r = await App.api('/payments', { method: 'POST', body: { studentId: s.id, month: f('pMonth').value, amount: Number(f('pAmount').value), method: f('pMethod').value } });
      modal.hide();
      App.toast(`Payment saved. Receipt ${r.payment.receipt_no}`, 'success');
      window.open('receipt.html?id=' + r.payment.id, '_blank');
      load();
    } catch (ex) { f('payError').textContent = ex.message; f('payError').classList.remove('d-none'); }
  });
  load();
})();
