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

// 成本價 / 損益打平價：解 V(p)=本金，其中 V(p)=L·(2√p − p/√pb − √pa)，tokenB=USDC≈$1。
// 路徑無關、精確，且自動含復投成本。價格回到此處 → 損益(不含手續費)=0、IL 打平。
function breakevenPrice(p) {
  const liq = p.liquidityUsd, dep = p.depositUsd, pn = p.currentPrice, pa = p.priceLower, pb = p.priceUpper;
  if (!(liq > 0) || !(dep > 0) || !(pn > 0) || !(pa > 0) || !(pb > pa)) return null;
  if (pn <= pa || pn >= pb) return null; // 出界時此公式不適用
  const sa = Math.sqrt(pa), sb = Math.sqrt(pb);
  const fNow = 2 * Math.sqrt(pn) - pn / sb - sa;
  if (!(fNow > 0)) return null;
  const target = fNow * (dep / liq);     // 想讓 V(p)=本金 → f(p)=fNow×(本金/現值)
  const disc = pb - sb * (sa + target);  // u² − 2·sb·u + sb·(sa+target)=0 的判別式/4
  if (disc < 0) return null;
  const u = sb - Math.sqrt(disc);        // 取 p≤pb 的根
  const pe = u * u;
  return pe > 0 ? pe : null;
}

// 成本價小字（接在投入本金後）：現價相對成本價的漲跌（跌=紅、有 IL；漲=綠）
function entrySub(p) {
  const be = breakevenPrice(p);
  if (be == null) return '';
  const cur = p.currentPrice;
  const chg = cur > 0 ? ((cur - be) / be) * 100 : null;
  const chgHtml = chg != null
    ? `（現價 <span class="${chg >= 0 ? 'pos-val' : 'neg-val'}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</span>）`
    : '';
  return ` <span class="sub">成本價 ${fmtPrice(be)}${chgHtml}</span>`;
}
const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '—');
const fmtTime = (iso) =>
  new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: '2-digit', month: '2-digit', day: '2-digit' }) : '—';
const fmtDuration = (days) => {
  const totalMin = Math.max(0, Math.round((days ?? 0) * 24 * 60));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return `${d}天 ${h}時 ${m}分`;
};

const RISK_LABEL = { low: '🟢 健康', medium: '🟡 偏離', high: '⚠️ 快出界', out: '🚨 已出界' };

// 摘要/策略卡片 HTML（tooltip 只掛在 ⓘ 上）
const cardHtml = (c) =>
  `<div class="card"><div class="label">${c.label}${c.tip ? ` <span class="info" data-tip="${c.tip}">ⓘ</span>` : ''}</div>
   <div class="value ${c.small ? 'small' : ''} ${c.cls || ''}">${c.value}</div></div>`;

let chart, historyData;
let suggestStyle = 'balanced';
let suggestHorizon = '1m';
let lastPositions = [];

// 區間建議：依風格(z 倍率)與持有期(交易日)從日波動度 σ 算出，不對稱(下限拉寬)
const STYLE_Z = { conservative: { z: 2.0, prob: 85 }, balanced: { z: 1.5, prob: 75 }, aggressive: { z: 1.0, prob: 65 } };
const HORIZON_DAYS = { '1w': 5, '1m': 21, '3m': 63, '6m': 126 };
const HORIZON_LABEL = { '1w': '1週', '1m': '1月', '3m': '3月', '6m': '6月' };
const LOWER_MULT = 1.3, UPPER_MULT = 0.85;
function calcRange(price, sigma, style, hKey) {
  if (!(price > 0) || !(sigma > 0)) return null;
  const { z, prob } = STYLE_Z[style];
  const move = sigma * Math.sqrt(HORIZON_DAYS[hKey] || 21);
  const lowPct = -(z * move * LOWER_MULT), upPct = z * move * UPPER_MULT;
  return { low: price * (1 + lowPct), high: price * (1 + upPct), lowPct: lowPct * 100, upPct: upPct * 100, stayProb: prob };
}

async function load() {
  const [latest, history] = await Promise.all([
    fetchState('latest', './data/latest.json'),
    fetchState('history', './data/history.json').catch(() => ({ equity: [], events: [] })),
  ]);
  if (!latest) return showError();
  historyData = history;
  render(latest, history);
}

/** 若有設定 Supabase（config.js），優先直讀 dashboard_state；失敗則退回讀靜態 JSON 檔。 */
function sbConfig() {
  const c = window.BYREAL_CONFIG || {};
  return c.SUPABASE_URL && c.SUPABASE_ANON_KEY ? c : null;
}

async function fetchState(key, fileUrl) {
  const c = sbConfig();
  if (c) {
    try {
      const url = `${c.SUPABASE_URL}/rest/v1/dashboard_state?key=eq.${key}&select=payload`;
      const res = await fetch(url, {
        headers: { apikey: c.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + c.SUPABASE_ANON_KEY },
        cache: 'no-store',
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows && rows[0] && rows[0].payload) return rows[0].payload;
      } else {
        console.warn('Supabase 讀取失敗，退回靜態檔', key, res.status);
      }
    } catch (e) {
      console.warn('Supabase 讀取例外，退回靜態檔', key, e);
    }
  }
  return fetchJson(fileUrl);
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
  setupStyleTabs();
}

function renderSummary(t) {
  const totalReturn = (t.earnedUsd ?? 0) + (t.pnlUsd ?? 0);
  const cards = [
    { label: '總倉位價值', value: fmtUsd(t.liquidityUsd),
      tip: '目前所有部位的現值總和（部位內兩種代幣數量 × 現價）。' },
    { label: '累積手續費', value: fmtUsd(t.earnedUsd), cls: 'pos-val',
      tip: '現有部位開倉至今的手續費（已領＋未領）。已關閉部位的手續費請看下方策略總覽。' },
    { label: '手續費年化', value: fmtPct(t.realApr ?? 0), cls: (t.realApr ?? 0) > 0 ? 'pos-val' : '',
      tip: '資金×時間加權：總手續費 ÷ (投入本金×持倉年數)。短持倉部位自動只佔小權重，不會把年化灌爆。不含價格漲跌。' },
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
  lastPositions = positions;
  if (!positions.length) { el.innerHTML = '<div class="empty">目前沒有部位</div>'; return; }

  el.innerHTML = positions
    .map((p) => {
      const span = p.priceUpper - p.priceLower || 1;
      let pos = ((p.currentPrice - p.priceLower) / span) * 100;
      pos = Math.max(2, Math.min(98, pos));
      const markerCls = p.inRange ? '' : 'out';
      const sg = calcRange(p.currentPrice, p.volatilityDaily, suggestStyle, suggestHorizon);
      const suggestHtml = sg
        ? `<div class="suggest">💡 建議區間 <span class="sg-tag">${HORIZON_LABEL[suggestHorizon]}</span> <b>${fmtPrice(sg.low)} ~ ${fmtPrice(sg.high)}</b>
             <span class="sg-pct">(${sg.lowPct.toFixed(1)}% / +${sg.upPct.toFixed(1)}%)</span>
             <span class="sg-prob" data-tip="此風格的名目「在區間內時間比例」估計值。持有期越長/區間越寬越能撐住，但手續費年化會越低。">在內 ~${sg.stayProb}% ⓘ</span></div>`
        : '';
      // 上下限相對現價的差距%（下限通常為負、上限為正）
      const lowPct = p.currentPrice > 0 ? ((p.priceLower - p.currentPrice) / p.currentPrice) * 100 : 0;
      const upPct = p.currentPrice > 0 ? ((p.priceUpper - p.currentPrice) / p.currentPrice) * 100 : 0;
      const sgn = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
      return `
      <div class="pos">
        <div class="pos-top">
          <div class="pt-left">
            <span class="pair">${p.pair}</span>
            <span class="badge ${p.riskLevel}">${RISK_LABEL[p.riskLevel] || p.riskLevel}</span>
          </div>
          <span class="hold">⏱ 持倉 ${fmtDuration(p.ageDays)}</span>
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
        ${suggestHtml}
      </div>`;
    })
    .join('');
}

function setupStyleTabs() {
  document.querySelectorAll('#styleTabs button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#styleTabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      suggestStyle = btn.dataset.style;
      renderPositions(lastPositions);
    };
  });
  document.querySelectorAll('#horizonTabs button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#horizonTabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      suggestHorizon = btn.dataset.h;
      renderPositions(lastPositions);
    };
  });
}

function perfMetrics(p) {
  const young = (p.ageDays ?? 99) < 2;
  const ageNote = young ? '⚠️ 持倉不足 2 天，年化是把短期速率外推一整年，數字會嚴重偏大、僅供參考。' : '';
  const ut = p.unclaimedTokens || [];
  const breakdown = ut.length ? '；未領明細｜' + ut.map((t) => `${t.symbol} ${fmtAmt(t.amount)}（${fmtUsd(t.usd)}）`).join('；') : '';
  return [
    mtr('倉位價值', fmtUsd(p.liquidityUsd), '此部位目前現值（兩種代幣數量 × 現價）。'),
    mtr('投入本金', fmtUsd(p.depositUsd ?? 0) + entrySub(p),
      '開倉至今投入此部位的本金（含復投）。「成本價」＝損益(不含手續費)歸零的幣價，由「目前倉位現值／本金／上下限」反推，路徑無關且精確：價格回到這裡，IL 就打平。現價在成本價之上＝正 price PnL；之下＝有 IL。已含復投成本。'
      + (p.entryPrice ? ` 另：K 線開倉日約 ${fmtPrice(p.entryPrice)}（粗略、受單日波動影響）。` : '')),
    mtr('未領 / 累計手續費', `${fmtUsd(p.unclaimedFeeUsd ?? 0)} / ${fmtUsd(p.earnedUsd ?? 0)}`,
      `左＝目前可領取的「未領」；右＝開倉至今「累計」(已領 ${fmtUsd(p.claimedFeeUsd ?? 0)} ＋ 未領 ${fmtUsd(p.unclaimedFeeUsd ?? 0)})。即使領出賣掉仍記得(鏈上累計值)${breakdown}`, 'pos-val'),
    mtr('手續費年化', fmtPct(p.realApr ?? 0) + (young ? ' ⚠️' : ''), '只含手續費：(累計手續費 ÷ 投入本金) 依持倉時間年化。' + ageNote, (p.realApr ?? 0) > 0 ? 'pos-val' : ''),
    mtr('損益(不含手續費)', fmtUsd(p.pnlUsd), '代幣價格變動 / 無常損失（IL），不含手續費。', cls(p.pnlUsd)),
    mtr('總報酬', fmtUsd(p.totalReturnUsd ?? ((p.earnedUsd ?? 0) + (p.pnlUsd ?? 0))), '累積手續費 ＋ 損益的合計金額（你這筆實際賺賠多少）。', cls(p.totalReturnUsd ?? ((p.earnedUsd ?? 0) + (p.pnlUsd ?? 0)))),
    mtr('總報酬年化', fmtPct(p.totalReturnApr ?? 0) + (young ? ' ⚠️' : ''), '含損益：(總報酬 ÷ 投入本金) 年化。' + ageNote, cls(p.totalReturnApr ?? 0)),
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

// 事件類型 → 圖示 + 中文標籤（也決定篩選器的分類）
const EVENT_TYPES = {
  open:             { icon: '🆕', label: '新開倉' },
  close:            { icon: '📕', label: '關閉部位' },
  rebalance:        { icon: '🔄', label: '調倉' },
  fee_claim:        { icon: '💰', label: '領取手續費' },
  add_liquidity:    { icon: '➕', label: '添加流動性' },
  remove_liquidity: { icon: '➖', label: '移除流動性' },
  out_of_range:     { icon: '🚨', label: '價格超出提醒' },
  range_warning:    { icon: '⚠️', label: '價格偏離提醒' },
  back_in_range:    { icon: '✅', label: '回到區間內' },
};

let allEvents = [];
let activeEventTypes = null; // Set<string>；null 代表尚未初始化（=全選）
let eventPage = 0;
const EVENTS_PER_PAGE = 10;

function renderEvents(events) {
  allEvents = (events || []).slice(0, 200);
  // 哪些類型實際出現過（依 EVENT_TYPES 的順序排列）
  const present = Object.keys(EVENT_TYPES).filter((t) => allEvents.some((e) => e.type === t));
  // 也把未知類型歸到清單末端，避免被篩掉看不到
  for (const e of allEvents) if (!EVENT_TYPES[e.type] && !present.includes(e.type)) present.push(e.type);

  if (activeEventTypes === null) activeEventTypes = new Set(present);
  else for (const t of present) if (!knownTypesSeen.has(t)) activeEventTypes.add(t); // 新出現的類型預設開啟
  for (const t of present) knownTypesSeen.add(t);

  eventPage = 0;
  renderEventFilters(present);
  renderEventList();
}

const knownTypesSeen = new Set();

function renderEventFilters(present) {
  const box = document.getElementById('eventFilters');
  if (!box) return;
  if (present.length <= 1) { box.innerHTML = ''; return; } // 只有一種類型就不顯示篩選器
  const counts = {};
  for (const e of allEvents) counts[e.type] = (counts[e.type] || 0) + 1;
  box.innerHTML = present
    .map((t) => {
      const meta = EVENT_TYPES[t] || { icon: '•', label: t };
      const on = activeEventTypes.has(t);
      return `<button class="evt-chip${on ? ' active' : ''}" data-type="${t}">${meta.icon} ${meta.label}<span class="cnt">${counts[t] || 0}</span></button>`;
    })
    .join('');
  box.querySelectorAll('.evt-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type;
      if (activeEventTypes.has(t)) activeEventTypes.delete(t); else activeEventTypes.add(t);
      btn.classList.toggle('active');
      eventPage = 0;
      renderEventList();
    });
  });
}

function renderEventList() {
  const el = document.getElementById('events');
  const pager = document.getElementById('eventsPager');
  if (pager) pager.innerHTML = '';
  if (!allEvents.length) { el.innerHTML = '<div class="empty">尚無動作紀錄</div>'; return; }
  const list = allEvents.filter((e) => !activeEventTypes || activeEventTypes.has(e.type));
  if (!list.length) { el.innerHTML = '<div class="empty">目前篩選條件下沒有紀錄</div>'; return; }

  const pages = Math.ceil(list.length / EVENTS_PER_PAGE);
  eventPage = Math.max(0, Math.min(eventPage, pages - 1));
  const slice = list.slice(eventPage * EVENTS_PER_PAGE, eventPage * EVENTS_PER_PAGE + EVENTS_PER_PAGE);
  el.innerHTML = slice
    .map((e) => `<div class="evt"><span class="time">${fmtTime(e.occurredAt)}</span><span class="msg">${stripHtml(e.message)}</span></div>`)
    .join('');

  if (pager && pages > 1) {
    pager.innerHTML = `<button ${eventPage === 0 ? 'disabled' : ''} id="ePrev">‹ 上一頁</button>
      <span>${eventPage + 1} / ${pages}（共 ${list.length} 筆）</span>
      <button ${eventPage >= pages - 1 ? 'disabled' : ''} id="eNext">下一頁 ›</button>`;
    const prev = document.getElementById('ePrev'), next = document.getElementById('eNext');
    if (prev) prev.onclick = () => { eventPage--; renderEventList(); };
    if (next) next.onclick = () => { eventPage++; renderEventList(); };
  }
}

function stripHtml(s) { return String(s || '').replace(/<\/?b>/g, ''); }

const METRIC_LABEL = { liquidityUsd: '總倉位 (USD)', lifetimeFeesUsd: '累計手續費 (USD)', dailyFeeUsd: '每日手續費 (USD)', feeApr: '策略手續費年化 (%)' };
const CHART_TITLE = { liquidityUsd: '總倉位', lifetimeFeesUsd: '累計手續費', dailyFeeUsd: '每日手續費', feeApr: '策略手續費年化' };

function renderChart(equity, metric) {
  const titleEl = document.getElementById('chartTitle');
  if (titleEl) titleEl.textContent = CHART_TITLE[metric] || '權益走勢';
  const ctx = document.getElementById('equityChart');
  const labels = equity.map((e) => e.date.slice(5));
  const data = equity.map((e) => e[metric]);
  const isBar = metric === 'dailyFeeUsd';
  const color = metric === 'dailyFeeUsd' || metric === 'lifetimeFeesUsd' ? '#34d399' : '#4f9dff';

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: isBar ? 'bar' : 'line',
    data: {
      labels,
      datasets: [{
        label: METRIC_LABEL[metric], data,
        borderColor: color, backgroundColor: isBar ? color + '99' : color + '22',
        fill: !isBar, tension: 0.3, pointRadius: 2, borderWidth: 2, borderRadius: isBar ? 4 : 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              if (metric === 'feeApr') return `${CHART_TITLE[metric]}：${(v ?? 0).toFixed(1)}%`;
              if (metric === 'dailyFeeUsd') {
                const row = equity[c.dataIndex] || {};
                const liq = row.liquidityUsd || 0;
                const apr = liq > 0 ? (v / liq) * 365 * 100 : 0;
                const lines = [`當日手續費：${fmtUsd(v)}`];
                if (liq > 0) lines.push(`當天總倉位：${fmtUsd(liq)}`, `當日年化：~${apr.toFixed(1)}%`);
                if (c.dataIndex === equity.length - 1) lines.push('（今日累積中，年化僅參考）');
                return lines;
              }
              return `${CHART_TITLE[metric]}：${fmtUsd(v)}`;
            },
          },
        },
      },
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
