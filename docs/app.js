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
// CLMM 集中倍數（相對「全幅 0~∞」的資金效率）：E = 1 / (1 - (下限/上限)^(1/4))
// 區間越窄 → 倍數越高 → 在區間內時手續費年化越高，但越容易出界
const concFactor = (p) => {
  const pa = p.priceLower, pb = p.priceUpper;
  if (!pa || !pb || pb <= pa) return '—';
  const e = 1 / (1 - Math.pow(pa / pb, 0.25));
  return Number.isFinite(e) && e > 0 ? `${e.toFixed(1)}×` : '—';
};
const fmtAmt = (n) => (n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : Number(n).toPrecision(3));
// 一個帶 tooltip（滑鼠移過去顯示計算方式）的指標小卡
const mtr = (k, v, tip, valCls = '') =>
  `<div class="metric"><div class="k">${k}${tip ? ` <span class="info" data-tip="${tip}">ⓘ</span>` : ''}</div><div class="v ${valCls}">${v}</div></div>`;
const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '—');
const fmtTime = (iso) =>
  new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: '2-digit', month: '2-digit', day: '2-digit' }) : '—';

const RISK_LABEL = { low: '🟢 健康', medium: '🟡 偏離', high: '⚠️ 快出界', out: '🚨 已出界' };

// 摘要/策略卡片 HTML（tooltip 只掛在 ⓘ 上）
const cardHtml = (c) =>
  `<div class="card"><div class="label">${c.label}${c.tip ? ` <span class="info" data-tip="${c.tip}">ⓘ</span>` : ''}</div>
   <div class="value ${c.small ? 'small' : ''} ${c.cls || ''}">${c.value}</div></div>`;

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
  renderStrategy(snap.strategy);
  renderPositions(snap.positions || []);
  renderClosed(snap.closedPositions || []);
  renderEvents(history.events || []);
  renderChart(history.equity || [], 'liquidityUsd');
  setupTabs();
}

function renderSummary(t) {
  const totalReturn = (t.earnedUsd ?? 0) + (t.pnlUsd ?? 0);
  const cards = [
    { label: '總倉位價值', value: fmtUsd(t.liquidityUsd),
      tip: '目前所有部位的現值總和（部位內兩種代幣數量 × 現價）。' },
    { label: '投入本金', value: fmtUsd(t.depositUsd ?? 0),
      tip: '目前現有部位投入的本金合計。' },
    { label: '累積手續費', value: fmtUsd(t.earnedUsd), cls: 'pos-val',
      tip: '現有部位開倉至今的手續費（已領＋未領）。已關閉部位的手續費請看下方策略總覽。' },
    { label: '手續費年化', value: fmtPct(t.realApr ?? 0), cls: (t.realApr ?? 0) > 0 ? 'pos-val' : '',
      tip: '只算手續費：Σ(累計手續費) ÷ 投入本金，再依持倉時間換算成一年。不含價格漲跌。' },
    { label: '損益(不含手續費)', value: fmtUsd(t.pnlUsd), cls: cls(t.pnlUsd),
      tip: '只看「現有部位」的未實現損益：部位現值 − 投入本金，來自代幣價格變動與無常損失（IL）。不含手續費。' },
    { label: '總報酬', value: fmtUsd(totalReturn), cls: cls(totalReturn),
      tip: '手續費 ＋ 損益的合計金額（現有部位）。' },
    { label: '總報酬年化', value: fmtPct(t.totalReturnApr ?? 0), cls: cls(t.totalReturnApr ?? 0),
      tip: '含手續費＋損益：Σ(累計手續費 + 損益) ÷ 投入本金，年化。' },
    { label: '部位 / 區間內', value: `${t.positionCount} / ${t.inRangeCount}`, small: true,
      tip: '目前部位數 / 價格仍在區間內（持續賺手續費）的部位數。' },
  ];
  document.getElementById('summaryCards').innerHTML = cards.map(cardHtml).join('');
}

function renderStrategy(s) {
  const panel = document.getElementById('strategyPanel');
  if (!s) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const totalReturn = (s.lifetimeFeesUsd ?? 0) + (s.lifetimePnlUsd ?? 0);
  const cards = [
    { label: '累計手續費', value: fmtUsd(s.lifetimeFeesUsd), cls: 'pos-val',
      tip: `含已關閉 ${fmtUsd(s.realizedFeesUsd)} ＋ 現有 ${fmtUsd(s.unrealizedFeesUsd)}` },
    { label: '策略手續費年化', value: fmtPct(s.feeApr), cls: s.feeApr > 0 ? 'pos-val' : '',
      tip: '資金×時間加權：累計手續費(含已關閉) ÷ Σ(本金×持倉年數)。把每一塊錢、每一天的手續費績效平均，開倉/關倉/加減倉都正確納入。' },
    { label: '總損益(不含手續費)', value: fmtUsd(s.lifetimePnlUsd), cls: cls(s.lifetimePnlUsd),
      tip: '所有部位(含已關閉)的已實現＋未實現損益合計，來自價格變動/無常損失，不含手續費。' },
    { label: '總報酬', value: fmtUsd(totalReturn), cls: cls(totalReturn),
      tip: '累計手續費 ＋ 累計損益（含已關閉部位）。' },
    { label: '策略總報酬年化', value: fmtPct(s.totalReturnApr), cls: cls(s.totalReturnApr),
      tip: '含損益：(累計手續費 + 累計損益) ÷ Σ(本金×持倉年數)。' },
    { label: '部位(現有/已關閉)', value: `${s.activeCount} / ${s.closedCount}`, small: true,
      tip: `已關閉部位平均持倉 ${(s.avgHoldDays ?? 0).toFixed(1)} 天` },
  ];
  document.getElementById('strategyCards').innerHTML = cards.map(cardHtml).join('');
}

let closedRows = [], closedPage = 0;
const CLOSED_PER_PAGE = 10;

function renderClosed(rows) {
  const panel = document.getElementById('closedPanel');
  if (!rows || !rows.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  closedRows = rows;
  closedPage = 0;
  renderClosedPage();
}

function renderClosedPage() {
  const total = closedRows.length;
  const pages = Math.ceil(total / CLOSED_PER_PAGE);
  closedPage = Math.max(0, Math.min(closedPage, pages - 1));
  const slice = closedRows.slice(closedPage * CLOSED_PER_PAGE, closedPage * CLOSED_PER_PAGE + CLOSED_PER_PAGE);
  document.getElementById('closedTitle').textContent = `已關閉部位歷史（${total} 筆）`;
  const head = `<div class="ct-row ct-head"><span>交易對</span><span>本金</span><span>手續費</span><span>損益</span><span>手續費年化</span><span>總報酬年化</span><span>持倉</span><span>開倉日</span></div>`;
  const body = slice.map((r) => `<div class="ct-row">
    <span class="pair-cell">${r.pair}</span>
    <span>${fmtUsd(r.depositUsd)}</span>
    <span class="pos-val">${fmtUsd(r.earnedUsd)}</span>
    <span class="${cls(r.pnlUsd)}">${fmtUsd(r.pnlUsd)}</span>
    <span>${fmtPct(r.feeApr)}</span>
    <span class="${cls(r.totalReturnApr)}">${fmtPct(r.totalReturnApr)}</span>
    <span>${(r.ageDays ?? 0).toFixed(1)}天</span>
    <span>${fmtDate(r.openTime)}</span>
  </div>`).join('');
  document.getElementById('closedPositions').innerHTML = head + body;

  const pager = document.getElementById('closedPager');
  if (pages <= 1) { pager.innerHTML = ''; return; }
  pager.innerHTML = `<button ${closedPage === 0 ? 'disabled' : ''} id="cPrev">‹ 上一頁</button>
    <span>${closedPage + 1} / ${pages}</span>
    <button ${closedPage >= pages - 1 ? 'disabled' : ''} id="cNext">下一頁 ›</button>`;
  const prev = document.getElementById('cPrev'), next = document.getElementById('cNext');
  if (prev) prev.onclick = () => { closedPage--; renderClosedPage(); };
  if (next) next.onclick = () => { closedPage++; renderClosedPage(); };
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
      // 上下限相對現價的差距%（下限通常為負、上限為正）
      const lowPct = p.currentPrice > 0 ? ((p.priceLower - p.currentPrice) / p.currentPrice) * 100 : 0;
      const upPct = p.currentPrice > 0 ? ((p.priceUpper - p.currentPrice) / p.currentPrice) * 100 : 0;
      const sgn = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
      return `
      <div class="pos">
        <div class="pos-top">
          <span class="pair">${p.pair}</span>
          <span class="badge ${p.riskLevel}">${RISK_LABEL[p.riskLevel] || p.riskLevel}</span>
        </div>

        <div class="pos-metrics">${perfMetrics(p)}</div>
        <div class="pos-metrics pool-metrics">${poolMetrics(p)}</div>

        <div class="rangebar">
          <div class="track"><div class="marker ${markerCls}" style="left:${pos}%"></div></div>
          <div class="cur-row"><span class="cur" style="left:${pos}%">${fmtPrice(p.currentPrice)}</span></div>
          <div class="labels">
            <span>${fmtPrice(p.priceLower)} <em>${sgn(lowPct)}</em></span>
            <span class="mid">區間</span>
            <span>${fmtPrice(p.priceUpper)} <em>${sgn(upPct)}</em></span>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

function perfMetrics(p) {
  const ut = p.unclaimedTokens || [];
  const breakdown = ut.length ? '；未領明細｜' + ut.map((t) => `${t.symbol} ${fmtAmt(t.amount)}（${fmtUsd(t.usd)}）`).join('；') : '';
  const feeTip = `此部位開倉至今手續費（已領 ${fmtUsd(p.claimedFeeUsd ?? 0)} ＋ 未領 ${fmtUsd(p.unclaimedFeeUsd ?? 0)}）。即使領出賣掉仍記得（鏈上累計值）${breakdown}`;
  return [
    mtr('倉位價值', fmtUsd(p.liquidityUsd), '此部位目前現值（兩種代幣數量 × 現價）。'),
    mtr('投入本金', fmtUsd(p.depositUsd ?? 0), '開倉至今投入此部位的本金（含後續加倉）。'),
    mtr('累積手續費', fmtUsd(p.earnedUsd), feeTip, 'pos-val'),
    mtr('手續費年化', fmtPct(p.realApr ?? 0), '只含手續費：(累計手續費 ÷ 投入本金) 依持倉時間年化。', (p.realApr ?? 0) > 0 ? 'pos-val' : ''),
    mtr('損益(不含手續費)', fmtUsd(p.pnlUsd), '代幣價格變動 / 無常損失（IL），不含手續費。', cls(p.pnlUsd)),
    mtr('總報酬', fmtUsd(p.totalReturnUsd ?? ((p.earnedUsd ?? 0) + (p.pnlUsd ?? 0))), '累積手續費 ＋ 損益的合計金額（你這筆實際賺賠多少）。', cls(p.totalReturnUsd ?? ((p.earnedUsd ?? 0) + (p.pnlUsd ?? 0)))),
    mtr('總報酬年化', fmtPct(p.totalReturnApr ?? 0), '含損益：((累計手續費 + 損益) ÷ 投入本金) 年化。', cls(p.totalReturnApr ?? 0)),
  ].join('');
}

function poolMetrics(p) {
  const distTxt = p.nearestBoundaryPct >= 0
    ? p.nearestBoundaryPct.toFixed(1) + '%'
    : '出界 ' + Math.abs(p.nearestBoundaryPct).toFixed(1) + '%';
  return [
    mtr('池子TVL', fmtUsd(p.poolTvlUsd ?? 0), '池子總鎖倉量。'),
    mtr('24hr量', fmtUsd(p.poolVolume24hUsd ?? 0), '池子 24 小時交易量。量 ÷ TVL = 週轉率，越高代表手續費越多。'),
    mtr('池子APR(全幅)', fmtPct(p.apr), '池子 24h 手續費 ÷ TVL 年化（全池平均的概念值，非你個人）。'),
    mtr('集中倍數', concFactor(p), '你的區間相對全幅(0~∞)的資金效率 = 1 ÷ (1 −(下限÷上限)^¼)。越高越集中，在區間內手續費率越高，但越容易出界。'),
    mtr('距邊界', distTxt, '目前價格距離最近區間邊界的百分比；越小越接近出界。'),
  ].join('');
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
const CHART_TITLE = { liquidityUsd: '總倉位', earnedUsd: '累計手續費', pnlUsd: '持倉損益', weightedApr: '加權 APR' };

function renderChart(equity, metric) {
  const titleEl = document.getElementById('chartTitle');
  if (titleEl) titleEl.textContent = CHART_TITLE[metric] || '權益走勢';
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
