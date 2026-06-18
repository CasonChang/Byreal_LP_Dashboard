/* 研究室：熱門池掃描表 + 區間試算器 */
const fmtUsd = (n) => { const a = Math.abs(n); if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`; if (a >= 1e3) return `$${(a / 1e3).toFixed(0)}k`; return `$${a.toFixed(0)}`; };
const STYLE_Z = { conservative: { z: 2.0, prob: 85 }, balanced: { z: 1.5, prob: 75 }, aggressive: { z: 1.0, prob: 65 } };
const HDAYS = { '1w': 5, '1m': 21, '3m': 63, '6m': 126 };

let pools = [];

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

async function load() {
  try {
    const j = await fetchScan();
    pools = j.pools || [];
    document.getElementById('scanTitle').textContent = `熱門池掃描（${pools.length} 池・${new Date(j.updatedAt).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}）`;
    renderScan();
    fillCalcPools();
  } catch {
    document.getElementById('scanTable').innerHTML = '<div class="empty">尚無掃描資料（daemon 啟動後幾分鐘內會產生）。</div>';
  }
  calc();
}

function renderScan() {
  const head = `<div class="ct-row ct-head"><span>#</span><span>交易對</span><span>手續費年化</span><span>TVL</span><span>24h量</span><span>週轉%</span><span>年化波動</span><span>效率分</span></div>`;
  const body = pools.map((c, i) => {
    const small = c.tvlUsd < 100000;
    return `<div class="ct-row">
      <span>${i + 1}</span>
      <span class="pair-cell">${c.pair}${small ? ' <em title="TVL過小、風險高">⚠️</em>' : ''}</span>
      <span class="pos-val">${c.feeApr.toFixed(0)}%</span>
      <span>${fmtUsd(c.tvlUsd)}</span>
      <span>${fmtUsd(c.vol24hUsd)}</span>
      <span>${c.turnover.toFixed(0)}</span>
      <span>${c.annVol.toFixed(0)}%</span>
      <span class="pos-val">${c.effScore.toFixed(2)}</span>
    </div>`;
  }).join('');
  document.getElementById('scanTable').innerHTML = head + body;
}

function fillCalcPools() {
  const sel = document.getElementById('calcPool');
  sel.innerHTML = '<option value="">— 自填波動度 —</option>' +
    pools.map((c) => `<option value="${c.annVol}">${c.pair}（年化波動 ${c.annVol.toFixed(0)}%）</option>`).join('');
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
