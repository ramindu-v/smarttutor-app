(async function () {
  const user = await App.init({ page: 'reports', roles: ['admin', 'coordinator'] });
  const { esc, pct, money } = App;
  if (user.role !== 'admin') document.querySelectorAll('.admin-only').forEach((x) => x.classList.add('d-none'));
  document.querySelectorAll('[data-csv]').forEach((b) => { b.onclick = () => App.download(b.dataset.csv); });
  const d = await App.api('/reports/overview');
  const brand = '#667eea', brand2 = '#764ba2';
  const percentAxis = { ticks: { callback: (v) => v + '%' } };

  new Chart(document.getElementById('weekly'), {
    type: 'line',
    data: { labels: d.weekly.map((w) => App.fmtDate(w.start)), datasets: [{ data: d.weekly.map((w) => +(w.rate * 100).toFixed(1)), borderColor: brand, backgroundColor: 'rgba(102,126,234,.12)', fill: true, tension: 0.35 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 50, max: 100, ...percentAxis } } },
  });
  new Chart(document.getElementById('risk'), {
    type: 'doughnut',
    data: { labels: ['High risk', 'Watch', 'On track'], datasets: [{ data: d.risk.map((r) => r.count), backgroundColor: ['#ef5350', '#ffa726', '#66bb6a'] }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
  });
  document.getElementById('riskNote').textContent = `${d.declining} students show a statistically clear drop in recent attendance.`;
  new Chart(document.getElementById('subject'), {
    type: 'bar',
    data: { labels: d.bySubject.map((s) => s.subject), datasets: [{ data: d.bySubject.map((s) => +(s.rate * 100).toFixed(1)), backgroundColor: brand }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 50, max: 100, ...percentAxis } } },
  });
  if (user.role === 'admin') {
    new Chart(document.getElementById('revenue'), {
      type: 'bar',
      data: {
        labels: d.revenue.map((r) => App.fmtMonth(r.month)),
        datasets: [{ label: 'Expected', data: d.revenue.map((r) => r.expected), backgroundColor: '#d1d9ff' }, { label: 'Collected', data: d.revenue.map((r) => r.collected), backgroundColor: brand2 }],
      },
      options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: (v) => 'Rs ' + (v / 1000) + 'k' } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.raw)}` } } } },
    });
  }
  new Chart(document.getElementById('workload'), {
    type: 'bar',
    data: { labels: d.workload.map((w) => w.name), datasets: [{ data: d.workload.map((w) => w.sessions), backgroundColor: '#9fa8da' }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { stepSize: 1 } } } },
  });
  document.getElementById('rooms').innerHTML = d.roomUse.map((r) => `<tr><td>${esc(r.room)} <small class="text-muted">${esc(r.branch.split(' - ').pop())}</small></td>
    <td>${r.capacity}</td><td>${r.sessions}</td><td>${pct(r.slotUse)}</td><td>${pct(r.seatUse)}</td></tr>`).join('');

  function renderModel(m) {
    document.getElementById('model').innerHTML = m ? `
      <div class="row g-3">
        <div class="col-6 col-md-3"><div class="stat-card text-center"><h3>${pct(m.accuracy, 1)}</h3><small class="text-muted">Accuracy on recent records</small></div></div>
        <div class="col-6 col-md-3"><div class="stat-card text-center"><h3>${pct(m.baselineAccuracy, 1)}</h3><small class="text-muted">Baseline (always "present")</small></div></div>
        <div class="col-6 col-md-3"><div class="stat-card text-center"><h3>${m.auc ? m.auc.toFixed(2) : '–'}</h3><small class="text-muted">ROC AUC</small></div></div>
        <div class="col-6 col-md-3"><div class="stat-card text-center"><h3>${pct(m.absenceRecall)}</h3><small class="text-muted">Absences flagged in advance (precision ${pct(m.absencePrecision)})</small></div></div>
      </div>
      <p class="small text-muted mt-3 mb-2">Logistic regression trained on ${m.trainSamples.toLocaleString()} attendance records and tested on the most recent ${m.testSamples.toLocaleString()} (a time-based split, so the model never sees the future).
        A student is flagged when the predicted chance of attending is below ${pct(m.riskThreshold)}. Last trained ${App.timeAgo(m.trainedAt)}.</p>
      <h6 class="mt-3">What the model pays attention to</h6>
      ${m.weights.map((w) => `<div class="d-flex align-items-center gap-2 small mb-1"><span style="width:220px">${esc(w.name)}</span>
        <div class="flex-grow-1"><div style="height:8px;border-radius:4px;width:${Math.min(100, Math.abs(w.weight) * 120)}%;background:${w.weight >= 0 ? '#66bb6a' : '#ef5350'}"></div></div>
        <span style="width:50px" class="text-end">${w.weight.toFixed(2)}</span></div>`).join('')}
      <p class="small text-muted mb-0">Green pushes the prediction towards "will attend", red towards "will miss". Features are standardised, so bar lengths are comparable.</p>`
      : '<div class="empty">Not enough attendance history to train the model yet.</div>';
  }
  renderModel(d.model);
  const rb = document.getElementById('retrainBtn');
  if (rb) rb.onclick = async () => { rb.disabled = true; const r = await App.api('/reports/retrain', { method: 'POST' }); renderModel(r.model); App.toast('Model retrained', 'success'); rb.disabled = false; };
})();
