/* 研究室：熱門池掃描表 + 區間試算器 */
const fmtUsd = (n) => { const a = Math.abs(n); if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`; if (a >= 1e3) return `$${(a / 1e3).toFixed(0)}k`; return `$${a.toFixed(0)}`; };
const STYLE_Z = { conservative: { z: 2.0, prob: 85 }, balanced: { z: 1.5, prob: 75 }, aggressive: { z: 1.0, prob: 65 } };
const HDAYS = { '1w': 5, '1m': 21, '3m': 63, '6m': 126 };

let pools = [];
let scanWindow = 'composite'; // 'composite' | '1w' | '1m' | '3m'
const WIN_LABEL = { composite: '綜合', '1w': '1週', '1m': '1月', '3m': '3月' };

function sbCfg() {
  const c = window.BYREAL_CONFIG || {};
  return c.SUPABASE_URL && c.SUPABASE_ANON_KEY ? c : null;
}

// 優先讀 Supabase dashboard_state['scan']，讀不到再退回靜態 scan.json
async function fetchScan() {
  const c = sbCfg();
  if (c) {
    try {
      const url = `${c.SUPABASE_URL}/rest/v1/dashboard_state?key=eq.scan&select=payload`;
      const res = await fetch(url, {
        headers: { apikey: c.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + c.SUPABASE_ANON_KEY },
        cache: 'no-store',
      });
      if (res.ok) { const rows = await res.json(); if (rows && rows[0] && rows[0].payload) return rows[0].payload; }
    } catch (e) { console.warn('scan Supabase 讀取失敗，退回靜態檔', e); }
  }
  const res = await fetch('./data/scan.json?t=' + Date.now());
  return res.json();
}

// 相容舊版 scan.json（沒有 win 欄位）
function normalizePool(c) {
  if (c.win) return c;
  const w = { days: 0, feeApr: c.feeApr || 0, annVol: c.annVol || 0, effScore: c.effScore || 0, volCv: 0 };
  return { ...c, feeApr24h: c.feeApr || 0, historyDays: 0, sigmaDaily: c.sigmaDaily || 0, win: { '1w': w, '1m': w, '3m': w }, compositeScore: c.effScore || 0 };
}

async function load() {
  try {
    const j = await fetchScan();
    pools = (j.pools || []).map(normalizePool);
    const t = new Date(j.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    document.getElementById('scanTitle').textContent = `熱門池長期掃描（${pools.length} 池・更新 ${t}）`;
    renderScanTabs();
    renderScan();
    fillCalcPools();
  } catch {
    document.getElementById('scanTable').innerHTML = '<div class="empty">尚無掃描資料（daemon 啟動後幾分鐘內會產生）。</div>';
  }
  calc();
}

function renderScanTabs() {
  const box = document.getElementById('scanWindowTabs');
  if (!box) return;
  box.innerHTML = '<span class="tabs-label">評分窗口</span>' +
    ['composite', '1w', '1m', '3m'].map((w) => `<button data-w="${w}" class="${w === scanWindow ? 'active' : ''}">${WIN_LABEL[w]}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => { b.onclick = () => { scanWindow = b.dataset.w; renderScanTabs(); renderScan(); }; });
}

// 取目前選定窗口要顯示的數據
function poolMetrics(c) {
  if (scanWindow === 'composite') {
    const w = c.win['1m'] || {};
    return { feeApr: w.feeApr || 0, annVol: w.annVol || 0, score: c.compositeScore || 0 };
  }
  const w = c.win[scanWindow] || {};
  return { feeApr: w.feeApr || 0, annVol: w.annVol || 0, score: w.effScore || 0 };
}

function renderScan() {
  const scoreHdr = scanWindow === 'composite' ? '綜合分' : '效率分';
  const sorted = [...pools].sort((a, b) => poolMetrics(b).score - poolMetrics(a).score);
  const head = `<div class="ct-row ct-head"><span>#</span><span>交易對</span><span>手續費年化</span><span>TVL</span><span>24h量</span><span>年化波動</span><span>${scoreHdr}</span><span>資料天</span></div>`;
  const body = sorted.map((c, i) => {
    const m = poolMetrics(c);
    const warns = [];
    if (c.tvlUsd < 100000) warns.push('TVL過小、易被操縱');
    if ((c.historyDays || 0) < 30) warns.push('歷史<30天、長期分僅供參考');
    const warn = warns.join('；');
    return `<div class="ct-row">
      <span>${i + 1}</span>
      <span class="pair-cell">${c.pair}${warn ? ` <em title="${warn}">⚠️</em>` : ''}</span>
      <span class="pos-val">${m.feeApr.toFixed(0)}%</span>
      <span>${fmtUsd(c.tvlUsd)}</span>
      <span>${fmtUsd(c.vol24hUsd)}</span>
      <span>${m.annVol.toFixed(0)}%</span>
      <span class="pos-val">${m.score.toFixed(2)}</span>
      <span>${c.historyDays || 0}</span>
    </div>`;
  }).join('');
  document.getElementById('scanTable').innerHTML = head + body;
}

function fillCalcPools() {
  const sel = document.getElementById('calcPool');
  sel.innerHTML = '<option value="">— 自填波動度 —</option>' +
    pools.map((c) => { const av = (c.win && c.win['1m'] && c.win['1m'].annVol) || 0; return `<option value="${av}">${c.pair}（年化波動 ${av.toFixed(0)}%）</option>`; }).join('');
  sel.onchange = () => {
    if (sel.value) document.getElementById('calcSigma').value = (parseFloat(sel.value) / Math.sqrt(365)).toFixed(2);
    calc();
  };
}

function calc() {
  const sigma = (parseFloat(document.getElementById('calcSigma').value) || 0) / 100;
  const style = document.getElementById('calcStyle').value;
  const hKey = document.getElementById('calcHorizon').value;
  const { z, prob } = STYLE_Z[style];
  const move = sigma * Math.sqrt(HDAYS[hKey]);
  const lowPct = -(z * move * 1.3) * 100, upPct = (z * move * 0.85) * 100;
  const ratio = (1 + lowPct / 100) / (1 + upPct / 100);
  const e = ratio > 0 ? 1 / (1 - Math.pow(ratio, 0.25)) : 0;
  document.getElementById('calcOut').innerHTML = `
    <div class="calc-card"><div class="label">建議下限</div><div class="value neg-val">${lowPct.toFixed(1)}%</div></div>
    <div class="calc-card"><div class="label">建議上限</div><div class="value pos-val">+${upPct.toFixed(1)}%</div></div>
    <div class="calc-card"><div class="label">區間總寬</div><div class="value">${(upPct - lowPct).toFixed(1)}%</div></div>
    <div class="calc-card"><div class="label">集中倍數</div><div class="value">${e ? e.toFixed(1) + '×' : '—'}</div></div>
    <div class="calc-card"><div class="label">風格在內(估)</div><div class="value">~${prob}%</div></div>`;
}

['calcSigma', 'calcStyle', 'calcHorizon'].forEach((id) => document.getElementById(id).addEventListener('input', calc));
load();
