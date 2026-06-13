/* Byreal LP 儀表板前端：讀取 ./data/latest.json 與 ./data/history.json 並渲染。 */

const fmtUsd = (n) => {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1000) return `${s}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `${s}$${a.toFixed(2)}`;
};
const fmtPct = (n) => `${n.toFixed(2)}%`;
const fmtPrice = (n) => {
  if (!n) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
};
const cls = (n) => (n > 0 ? 'pos-val' : n < 0 ? 'neg-val' : '');
const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '—');
const fmtTime = (iso) =>
  new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

const RISK_LABEL = { low: '🟢 健康', medium: '🟡 偏離', high: '⚠️ 快出界', out: '🚨 已出界' };

let chart, historyData;

async function load() {
  const [latest, history] = await Promise.all([
    fetchJson('./data/latest.json'),
    fetchJson('./data/history.json').catch(() => ({ equity: [], events: [] })),
  ]);
  if (!latest) return showError();
  historyData = history;
  render(latest, history);
}

async function fetchJson(url) {
  const res = await fetch(url + '?t=' + Date.now());
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

function showError() {
  document.getElementById('app').innerHTML =
    '<div class="empty">尚無資料。請先執行資料收集（GitHub Actions）或本地 <code>npm run mock</code> 產生示範資料。</div>';
}

function render(snap, history) {
  document.getElementById('wallet').textContent = (snap.wallets || []).map(shortAddr).join(', ');
  document.getElementById('updatedAt').textContent = '更新於 ' + fmtTime(snap.capturedAt);

  renderSummary(snap.totals);
  renderPositions(snap.positions || []);
  renderEvents(history.events || []);
  renderChart(history.equity || [], 'liquidityUsd');
  setupTabs();
}

function renderSummary(t) {
  const cards = [
    { label: '總倉位價值', value: fmtUsd(t.liquidityUsd) },
    { label: '未領手續費', value: fmtUsd(t.earnedUsd), cls: 'pos-val' },
    { label: '未領獎勵', value: fmtUsd(t.bonusUsd), cls: t.bonusUsd > 0 ? 'pos-val' : '' },
    { label: '持倉損益', value: fmtUsd(t.pnlUsd), cls: cls(t.pnlUsd) },
    { label: '加權 APR', value: fmtPct(t.weightedApr) },
    { label: '部位 / 區間內', value: `${t.positionCount} / ${t.inRangeCount}`, small: true },
  ];
  document.getElementById('summaryCards').innerHTML = cards
    .map(
      (c) => `<div class="card"><div class="label">${c.label}</div>
      <div class="value ${c.small ? 'small' : ''} ${c.cls || ''}">${c.value}</div></div>`,
    )
    .join('');
}

function renderPositions(positions) {
  const el = document.getElementById('positions');
  if (!positions.length) { el.innerHTML = '<div class="empty">目前沒有部位</div>'; return; }

  el.innerHTML = positions
    .map((p) => {
      const span = p.priceUpper - p.priceLower || 1;
      let pos = ((p.currentPrice - p.priceLower) / span) * 100;
      pos = Math.max(2, Math.min(98, pos));
      const markerCls = p.inRange ? '' : 'out';
      return `
      <div class="pos">
        <div class="pos-top">
          <div>
            <span class="pair">${p.pair}</span>
            <span class="badge ${p.riskLevel}">${RISK_LABEL[p.riskLevel] || p.riskLevel}</span>
          </div>
          <div class="metric"><span class="v">${fmtUsd(p.liquidityUsd)}</span></div>
        </div>

        <div class="pos-metrics">
          <div class="metric"><div class="k">手續費</div><div class="v pos-val">${fmtUsd(p.earnedUsd)}</div></div>
          <div class="metric"><div class="k">獎勵</div><div class="v">${fmtUsd(p.bonusUsd)}</div></div>
          <div class="metric"><div class="k">損益</div><div class="v ${cls(p.pnlUsd)}">${fmtUsd(p.pnlUsd)}</div></div>
          <div class="metric"><div class="k">APR</div><div class="v">${fmtPct(p.apr)}</div></div>
          <div class="metric"><div class="k">目前價格</div><div class="v">${fmtPrice(p.currentPrice)}</div></div>
          <div class="metric"><div class="k">距邊界</div><div class="v">${p.nearestBoundaryPct >= 0 ? p.nearestBoundaryPct.toFixed(1) : '出界 ' + Math.abs(p.nearestBoundaryPct).toFixed(1)}%</div></div>
        </div>

        <div class="rangebar">
          <div class="track"><div class="marker ${markerCls}" style="left:${pos}%"></div></div>
          <div class="labels"><span>${fmtPrice(p.priceLower)}</span><span>區間</span><span>${fmtPrice(p.priceUpper)}</span></div>
        </div>
      </div>`;
    })
    .join('');
}

function renderEvents(events) {
  const el = document.getElementById('events');
  if (!events.length) { el.innerHTML = '<div class="empty">尚無動作紀錄</div>'; return; }
  el.innerHTML = events
    .slice(0, 50)
    .map((e) => `<div class="evt"><span class="time">${fmtTime(e.occurredAt)}</span><span class="msg">${stripHtml(e.message)}</span></div>`)
    .join('');
}

function stripHtml(s) { return String(s || '').replace(/<\/?b>/g, ''); }

const METRIC_LABEL = { liquidityUsd: '總倉位 (USD)', earnedUsd: '累計手續費 (USD)', pnlUsd: '持倉損益 (USD)', weightedApr: '加權 APR (%)' };

function renderChart(equity, metric) {
  const ctx = document.getElementById('equityChart');
  const labels = equity.map((e) => e.date.slice(5));
  const data = equity.map((e) => e[metric]);
  const color = metric === 'pnlUsd' ? '#fbbf24' : '#4f9dff';

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: METRIC_LABEL[metric], data,
        borderColor: color, backgroundColor: color + '22',
        fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#1e2741' }, ticks: { color: '#8a98b5', maxTicksLimit: 10 } },
        y: { grid: { color: '#1e2741' }, ticks: { color: '#8a98b5' } },
      },
    },
  });
}

function setupTabs() {
  document.querySelectorAll('#chartTabs button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#chartTabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderChart(historyData.equity || [], btn.dataset.metric);
    };
  });
}

document.getElementById('refreshBtn').onclick = load;
load().catch(showError);
