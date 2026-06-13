/**
 * Byreal dex/v2 API client（唯讀，只需要錢包地址）。
 * 端點參考 byreal-git/byreal-agent-skills 的 src/core/constants.ts。
 */

import { config } from './config.ts';
import type { ByrealEnvelope, RawPosition, RawPositionListData } from './types.ts';

const ENDPOINTS = {
  POSITIONS_LIST: '/byreal/api/dex/v2/position/list',
  POOL_DETAILS: '/byreal/api/dex/v2/pools/details',
};

async function apiGet<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(config.byrealApiUrl + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Byreal API ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** 取得某錢包所有部位（自動翻頁）。 */
export async function listPositions(
  userAddress: string,
  status: 0 | 1 = 0,
): Promise<{ positions: RawPosition[]; poolMap: Record<string, PoolMapFlat> }> {
  const all: RawPosition[] = [];
  const poolMap: Record<string, PoolMapFlat> = {};
  let page = 1;
  const pageSize = 50;

  for (;;) {
    const env = await apiGet<ByrealEnvelope<RawPositionListData>>(ENDPOINTS.POSITIONS_LIST, {
      userAddress,
      page,
      pageSize,
      status,
    });
    const data = env?.result?.data;
    if (!data) break;
    const batch = data.positions || data.records || [];
    all.push(...batch);
    Object.assign(poolMap, normalizePoolMap(data.poolMap));
    const total = data.total ?? all.length;
    if (all.length >= total || batch.length === 0) break;
    page += 1;
    if (page > 50) break; // 安全閥
  }
  return { positions: all, poolMap };
}

export interface PoolMapFlat {
  symbolA: string;
  symbolB: string;
  decimalsA: number;
  decimalsB: number;
  addressA: string;
  addressB: string;
}

function normalizePoolMap(raw: RawPositionListData['poolMap']): Record<string, PoolMapFlat> {
  const out: Record<string, PoolMapFlat> = {};
  for (const [addr, entry] of Object.entries(raw || {})) {
    out[addr] = {
      symbolA: entry.mintA?.symbol || '',
      symbolB: entry.mintB?.symbol || '',
      decimalsA: entry.mintA?.decimals ?? 0,
      decimalsB: entry.mintB?.decimals ?? 0,
      addressA: entry.mintA?.address || '',
      addressB: entry.mintB?.address || '',
    };
  }
  return out;
}

export interface PoolDetail {
  poolAddress: string;
  symbolA: string;
  symbolB: string;
  decimalsA: number;
  decimalsB: number;
  priceAUsd: number;
  priceBUsd: number;
  /** tokenA 以 tokenB 計價（B per A），= priceAUsd / priceBUsd */
  currentPrice: number;
  tvlUsd: number;
  volume24hUsd: number;
  feeApr: number; // 百分比
}

/** 取得單一池子詳情（價格、TVL、APR、decimals）。 */
export async function getPoolDetail(poolAddress: string): Promise<PoolDetail | null> {
  const env = await apiGet<ByrealEnvelope<any>>(ENDPOINTS.POOL_DETAILS, { poolAddress });
  const p = env?.result?.data;
  if (!p) return null;

  const mintA = p.mintA?.mintInfo || p.mintA || {};
  const mintB = p.mintB?.mintInfo || p.mintB || {};
  const priceAUsd = parseFloat(p.baseMint?.price ?? p.mintA?.price ?? '0');
  const priceBUsd = parseFloat(p.quoteMint?.price ?? p.mintB?.price ?? '0');
  const currentPrice = priceBUsd > 0 ? priceAUsd / priceBUsd : 0;

  return {
    poolAddress: p.poolAddress || poolAddress,
    symbolA: mintA.symbol || '',
    symbolB: mintB.symbol || '',
    decimalsA: mintA.decimals ?? 0,
    decimalsB: mintB.decimals ?? 0,
    priceAUsd,
    priceBUsd,
    currentPrice,
    tvlUsd: parseFloat(p.tvl ?? '0'),
    volume24hUsd: parseFloat(p.volumeUsd1d ?? p.volumeUsd24h ?? '0'),
    feeApr: parseFloat(p.feeApr24h ?? '0') * 100,
  };
}
