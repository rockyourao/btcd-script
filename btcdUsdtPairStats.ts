/**
 * BTCD/USDT 自定义兑换合约日统计（非 Uniswap V2 Pair）
 *
 * 合约 0xFF60...497F：1:1 兑换池。Swap / 加流动性有合约事件，撤流动性无事件。
 * 本脚本通过 BTCD / USDT 相对该合约的 Transfer 按交易分类：
 *   - Swap: 单边转入 + 另一边转出
 *   - Mint(加流动性): 同时转入 BTCD + USDT
 *   - Burn(撤流动性): 同时转出 BTCD + USDT
 *   - 超额取出: 按用户累计 Burn > Mint 的差额（运营/做市超额提取）
 *   - 用户排行: 提供/取走（Mint|Burn + Skipped 单边）与 Swap 总量
 *   - Skipped: 未归入以上类别的 Transfer 交易（单边注资/复杂路径等）
 *   - 对账: Pair 链上余额 vs 隐含余额（Mint−Burn+Swap净[+Skipped净]）
 *
 * 使用方法:
 * npx ts-node btcdUsdtPairStats.ts
 * npx ts-node btcdUsdtPairStats.ts --network pgp-prod
 * npx ts-node btcdUsdtPairStats.ts --no-update
 * npx ts-node btcdUsdtPairStats.ts --rescan-events   # 全量重扫（含 skipped）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

import {
  formatTimestampDisplay,
  formatWithCommas,
  getBlockTimestamps,
  getUnitStartTimestamp,
  timestampToStr,
  topicToAddress
} from './util';

function getNetworkFromArgs(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return 'pgp-prod';
}

function parseArgs(): { update: boolean; rescanEvents: boolean } {
  let update = true;
  let rescanEvents = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-update') {
      update = false;
    } else if (args[i] === '--rescan-events') {
      rescanEvents = true;
    }
  }
  return { update, rescanEvents };
}

const network = getNetworkFromArgs();
const networkConfig = require('./networks.json') as Record<string, Record<string, unknown>>;
const cfg = networkConfig[network];
if (!cfg) {
  console.error(`未知网络: ${network}`);
  process.exit(1);
}

const PAIR_ADDRESS = (cfg.btcd_usdt_pair_address as string | undefined)?.toLowerCase();
const BTCD_TOKEN_ADDRESS = (cfg.stable_coin_contractaddress as string).toLowerCase();
const USDT_TOKEN_ADDRESS = (cfg.btcd_usdt_token_address as string | undefined)?.toLowerCase();
const INITIAL_START_BLOCK = cfg.start_block as number;
const BATCH_SIZE = (cfg.batch_size as number) || 10000;
const RPC_URL = cfg.rpc_url as string;
const TOKEN_DECIMALS = 18;

if (!PAIR_ADDRESS) {
  console.error(`networks.json 中 [${network}] 未配置 btcd_usdt_pair_address，无法继续。`);
  process.exit(1);
}
if (!USDT_TOKEN_ADDRESS) {
  console.error(`networks.json 中 [${network}] 未配置 btcd_usdt_token_address，无法继续。`);
  process.exit(1);
}

const OUTPUT_FILE = `data/${network}/btcd_usdt_pair_stats.json`;
const LIQUIDITY_OUTPUT_FILE = `data/${network}/btcd_usdt_pair_liquidity.json`;
const SMALLER_BATCH = 2000;
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');
const PAIR_TOPIC = '0x000000000000000000000000' + PAIR_ADDRESS.slice(2);

interface SwapRecord {
  user: string;
  direction: 'btcd_to_usdt' | 'usdt_to_btcd';
  btcdAmount: string;
  usdtAmount: string;
  blockNumber: number;
  timestamp: number;
  timestampStr: string;
  transactionHash: string;
}

interface LiquidityRecord {
  type: 'mint' | 'burn';
  user: string;
  btcdAmount: string;
  usdtAmount: string;
  blockNumber: number;
  timestamp: number;
  timestampStr: string;
  transactionHash: string;
}

/** 未归入 Mint/Burn/Swap 的交易（相对 Pair 的净 Transfer） */
interface SkippedRecord {
  user: string;
  pattern: string;
  btcdIn: string;
  btcdOut: string;
  usdtIn: string;
  usdtOut: string;
  blockNumber: number;
  timestamp: number;
  timestampStr: string;
  transactionHash: string;
}

interface DailyStats {
  date: string;
  timestamp: number;
  swapCount: number;
  btcdVolume: number;
  usdtVolume: number;
  btcdToUsdtCount: number;
  btcdToUsdtBtcd: number;
  btcdToUsdtUsdt: number;
  usdtToBtcdCount: number;
  usdtToBtcdBtcd: number;
  usdtToBtcdUsdt: number;
  mintCount: number;
  mintBtcd: number;
  mintUsdt: number;
  burnCount: number;
  burnBtcd: number;
  burnUsdt: number;
}

interface PairStatsFile {
  lastBlock: number;
  pair: string;
  btcdToken: string;
  usdtToken: string;
  stats: Record<string, number>;
  daily: DailyStats[];
  swaps: SwapRecord[];
  /** @deprecated 已拆到 LIQUIDITY_OUTPUT_FILE，仅兼容旧数据读取 */
  mints?: LiquidityRecord[];
  burns?: LiquidityRecord[];
}

interface ExcessWithdrawalUser {
  user: string;
  mintBtcd: number;
  burnBtcd: number;
  mintUsdt: number;
  burnUsdt: number;
  excessBtcd: number;
  excessUsdt: number;
  mintCount: number;
  burnCount: number;
}

interface ExcessWithdrawalFileStats {
  burnMinusMintBtcd: number;
  burnMinusMintUsdt: number;
  excessBtcd: number;
  excessUsdt: number;
  excessUserCount: number;
  users: ExcessWithdrawalUser[];
}

interface BalanceReconcileStats {
  onchainBtcd: number;
  onchainUsdt: number;
  impliedBtcd: number;
  impliedUsdt: number;
  impliedWithSkippedBtcd: number;
  impliedWithSkippedUsdt: number;
  gapBtcd: number;
  gapUsdt: number;
  gapWithSkippedBtcd: number;
  gapWithSkippedUsdt: number;
  skippedCount: number;
  skippedBtcdIn: number;
  skippedBtcdOut: number;
  skippedUsdtIn: number;
  skippedUsdtOut: number;
  skippedBtcdNet: number;
  skippedUsdtNet: number;
}

interface LiquidityFile {
  pair: string;
  btcdToken: string;
  usdtToken: string;
  mints: LiquidityRecord[];
  burns: LiquidityRecord[];
  skipped?: SkippedRecord[];
  excessWithdrawal?: ExcessWithdrawalFileStats;
  balanceReconcile?: BalanceReconcileStats;
  rankings?: UserRankingsFile;
}

interface UserLiquidityFlowAgg {
  user: string;
  provideBtcd: number;
  provideUsdt: number;
  provideCount: number;
  withdrawBtcd: number;
  withdrawUsdt: number;
  withdrawCount: number;
  /** 拆分：双边 Mint / Skipped 入金 */
  mintBtcd: number;
  mintUsdt: number;
  skipInBtcd: number;
  skipInUsdt: number;
  /** 拆分：双边 Burn / Skipped 出金 */
  burnBtcd: number;
  burnUsdt: number;
  skipOutBtcd: number;
  skipOutUsdt: number;
}

interface UserSwapAgg {
  user: string;
  swapCount: number;
  btcdVolume: number;
  usdtVolume: number;
  /** BTCD→USDT 的 USDT 累计（正贡献） */
  btcdToUsdtUsdt: number;
  /** USDT→BTCD 的 USDT 累计（负贡献） */
  usdtToBtcdUsdt: number;
  /** 净兑换 USDT = btcdToUsdtUsdt − usdtToBtcdUsdt（兑出 USDT 多为正） */
  netUsdt: number;
}

interface UserRankingsFile {
  provideByBtcd: UserLiquidityFlowAgg[];
  provideByUsdt: UserLiquidityFlowAgg[];
  withdrawByBtcd: UserLiquidityFlowAgg[];
  withdrawByUsdt: UserLiquidityFlowAgg[];
  swapByUsdt: UserSwapAgg[];
  swapNetUsdt: UserSwapAgg[];
  swapNetUsdtBottom: UserSwapAgg[];
  swapBtcdToUsdt: UserSwapAgg[];
  swapUsdtToBtcd: UserSwapAgg[];
}

interface TxFlow {
  blockNumber: number;
  btcdIn: any;
  btcdOut: any;
  usdtIn: any;
  usdtOut: any;
  /** 与 pair 交互的对手方（优先取非 pair 地址） */
  counterparty: string;
}

function emptyDaily(timestamp: number): DailyStats {
  return {
    date: formatTimestampDisplay(timestamp, 'day'),
    timestamp,
    swapCount: 0,
    btcdVolume: 0,
    usdtVolume: 0,
    btcdToUsdtCount: 0,
    btcdToUsdtBtcd: 0,
    btcdToUsdtUsdt: 0,
    usdtToBtcdCount: 0,
    usdtToBtcdBtcd: 0,
    usdtToBtcdUsdt: 0,
    mintCount: 0,
    mintBtcd: 0,
    mintUsdt: 0,
    burnCount: 0,
    burnBtcd: 0,
    burnUsdt: 0
  };
}

function toNum(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatAmt(raw: any): string {
  return ethers.utils.formatUnits(raw, TOKEN_DECIMALS);
}

function isZero(bn: any): boolean {
  return !bn || ethers.BigNumber.from(bn).isZero();
}

async function fetchTokenTransfersInvolvingPair(
  provider: any,
  tokenAddress: string,
  startBlock: number,
  endBlock: number,
  tokenName: string
): Promise<any[]> {
  const all: any[] = [];

  const fetchRange = async (fromBlock: number, toBlock: number) => {
    const [fromPair, toPair] = await Promise.all([
      provider.getLogs({
        address: tokenAddress,
        topics: [TRANSFER_TOPIC, PAIR_TOPIC, null],
        fromBlock,
        toBlock
      }),
      provider.getLogs({
        address: tokenAddress,
        topics: [TRANSFER_TOPIC, null, PAIR_TOPIC],
        fromBlock,
        toBlock
      })
    ]);
    return [...fromPair, ...toPair];
  };

  for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += BATCH_SIZE) {
    const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, endBlock);
    try {
      const logs = await fetchRange(fromBlock, toBlock);
      all.push(...logs);
      if (logs.length > 0) {
        console.log(
          `  ${tokenName} 区块 ${fromBlock}-${toBlock}: ${logs.length} 条 Transfer`
        );
      }
    } catch (error: any) {
      console.error(
        `  查询 ${tokenName} ${fromBlock}-${toBlock} 失败，缩小批次:`,
        error?.reason || error?.message || error
      );
      for (let subFrom = fromBlock; subFrom <= toBlock; subFrom += SMALLER_BATCH) {
        const subTo = Math.min(subFrom + SMALLER_BATCH - 1, toBlock);
        try {
          const logs = await fetchRange(subFrom, subTo);
          all.push(...logs);
        } catch (subError: any) {
          console.error(
            `  ${tokenName} 子批次 ${subFrom}-${subTo} 失败:`,
            subError?.reason || subError?.message || subError
          );
        }
      }
    }
  }

  return all;
}

function buildTxFlows(btcdLogs: any[], usdtLogs: any[]): Map<string, TxFlow> {
  const flows = new Map<string, TxFlow>();

  const ensure = (txHash: string, blockNumber: number): TxFlow => {
    let f = flows.get(txHash);
    if (!f) {
      f = {
        blockNumber,
        btcdIn: ethers.BigNumber.from(0),
        btcdOut: ethers.BigNumber.from(0),
        usdtIn: ethers.BigNumber.from(0),
        usdtOut: ethers.BigNumber.from(0),
        counterparty: ''
      };
      flows.set(txHash, f);
    }
    return f;
  };

  const apply = (logs: any[], token: 'btcd' | 'usdt') => {
    for (const log of logs) {
      const from = topicToAddress(log.topics[1]);
      const to = topicToAddress(log.topics[2]);
      const value = ethers.BigNumber.from(log.data);
      const f = ensure(log.transactionHash, log.blockNumber);

      if (from === PAIR_ADDRESS) {
        // pair -> user
        if (token === 'btcd') f.btcdOut = f.btcdOut.add(value);
        else f.usdtOut = f.usdtOut.add(value);
        if (!f.counterparty && to !== PAIR_ADDRESS) f.counterparty = to;
      } else if (to === PAIR_ADDRESS) {
        // user -> pair
        if (token === 'btcd') f.btcdIn = f.btcdIn.add(value);
        else f.usdtIn = f.usdtIn.add(value);
        if (!f.counterparty && from !== PAIR_ADDRESS) f.counterparty = from;
      }
    }
  };

  apply(btcdLogs, 'btcd');
  apply(usdtLogs, 'usdt');
  return flows;
}

function skippedPattern(
  hasBtcdIn: boolean,
  hasBtcdOut: boolean,
  hasUsdtIn: boolean,
  hasUsdtOut: boolean
): string {
  const parts: string[] = [];
  if (hasBtcdIn) parts.push('btcdIn');
  if (hasBtcdOut) parts.push('btcdOut');
  if (hasUsdtIn) parts.push('usdtIn');
  if (hasUsdtOut) parts.push('usdtOut');
  if (parts.length === 0) return 'empty';
  if (parts.length === 1) {
    if (hasBtcdIn) return 'btcd_in_only';
    if (hasUsdtIn) return 'usdt_in_only';
    if (hasBtcdOut) return 'btcd_out_only';
    if (hasUsdtOut) return 'usdt_out_only';
  }
  return parts.join('+');
}

function classifyFlows(
  flows: Map<string, TxFlow>,
  blockTimestamps: Map<number, number>
): {
  swaps: SwapRecord[];
  mints: LiquidityRecord[];
  burns: LiquidityRecord[];
  skipped: SkippedRecord[];
} {
  const swaps: SwapRecord[] = [];
  const mints: LiquidityRecord[] = [];
  const burns: LiquidityRecord[] = [];
  const skipped: SkippedRecord[] = [];

  for (const [txHash, f] of flows) {
    const timestamp = blockTimestamps.get(f.blockNumber) || 0;
    const timestampStr = timestamp ? timestampToStr(timestamp) : '';
    const user = f.counterparty || '';
    const base = {
      user,
      blockNumber: f.blockNumber,
      timestamp,
      timestampStr,
      transactionHash: txHash
    };

    const hasBtcdIn = !isZero(f.btcdIn);
    const hasBtcdOut = !isZero(f.btcdOut);
    const hasUsdtIn = !isZero(f.usdtIn);
    const hasUsdtOut = !isZero(f.usdtOut);

    // Mint: 两边都转入，无转出
    if (hasBtcdIn && hasUsdtIn && !hasBtcdOut && !hasUsdtOut) {
      mints.push({
        ...base,
        type: 'mint',
        btcdAmount: formatAmt(f.btcdIn),
        usdtAmount: formatAmt(f.usdtIn)
      });
      continue;
    }

    // Burn: 两边都转出，无转入
    if (hasBtcdOut && hasUsdtOut && !hasBtcdIn && !hasUsdtIn) {
      burns.push({
        ...base,
        type: 'burn',
        btcdAmount: formatAmt(f.btcdOut),
        usdtAmount: formatAmt(f.usdtOut)
      });
      continue;
    }

    // Swap USDT -> BTCD
    if (hasUsdtIn && hasBtcdOut && !hasBtcdIn && !hasUsdtOut) {
      swaps.push({
        ...base,
        direction: 'usdt_to_btcd',
        btcdAmount: formatAmt(f.btcdOut),
        usdtAmount: formatAmt(f.usdtIn)
      });
      continue;
    }

    // Swap BTCD -> USDT
    if (hasBtcdIn && hasUsdtOut && !hasUsdtIn && !hasBtcdOut) {
      swaps.push({
        ...base,
        direction: 'btcd_to_usdt',
        btcdAmount: formatAmt(f.btcdIn),
        usdtAmount: formatAmt(f.usdtOut)
      });
      continue;
    }

    skipped.push({
      ...base,
      pattern: skippedPattern(hasBtcdIn, hasBtcdOut, hasUsdtIn, hasUsdtOut),
      btcdIn: formatAmt(f.btcdIn),
      btcdOut: formatAmt(f.btcdOut),
      usdtIn: formatAmt(f.usdtIn),
      usdtOut: formatAmt(f.usdtOut)
    });
  }

  return { swaps, mints, burns, skipped };
}

function mergeByTxHash<T extends { transactionHash: string; blockNumber: number }>(
  existing: T[],
  incoming: T[]
): T[] {
  const map = new Map<string, T>();
  for (const item of existing) {
    map.set(item.transactionHash.toLowerCase(), item);
  }
  for (const item of incoming) {
    map.set(item.transactionHash.toLowerCase(), item);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber - b.blockNumber
      : a.transactionHash.localeCompare(b.transactionHash)
  );
}

function computeDailyAndTotals(
  swaps: SwapRecord[],
  mints: LiquidityRecord[],
  burns: LiquidityRecord[]
): { daily: DailyStats[]; stats: Record<string, number> } {
  const dailyMap = new Map<number, DailyStats>();

  const getDay = (ts: number): DailyStats => {
    const dayTs = getUnitStartTimestamp(ts, 'day');
    let d = dailyMap.get(dayTs);
    if (!d) {
      d = emptyDaily(dayTs);
      dailyMap.set(dayTs, d);
    }
    return d;
  };

  for (const s of swaps) {
    if (!s.timestamp) continue;
    const d = getDay(s.timestamp);
    const btcd = toNum(s.btcdAmount);
    const usdt = toNum(s.usdtAmount);
    d.swapCount += 1;
    d.btcdVolume += btcd;
    d.usdtVolume += usdt;
    if (s.direction === 'btcd_to_usdt') {
      d.btcdToUsdtCount += 1;
      d.btcdToUsdtBtcd += btcd;
      d.btcdToUsdtUsdt += usdt;
    } else {
      d.usdtToBtcdCount += 1;
      d.usdtToBtcdBtcd += btcd;
      d.usdtToBtcdUsdt += usdt;
    }
  }

  for (const m of mints) {
    if (!m.timestamp) continue;
    const d = getDay(m.timestamp);
    d.mintCount += 1;
    d.mintBtcd += toNum(m.btcdAmount);
    d.mintUsdt += toNum(m.usdtAmount);
  }

  for (const b of burns) {
    if (!b.timestamp) continue;
    const d = getDay(b.timestamp);
    d.burnCount += 1;
    d.burnBtcd += toNum(b.btcdAmount);
    d.burnUsdt += toNum(b.usdtAmount);
  }

  const daily = Array.from(dailyMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  const stats = {
    swapCount: daily.reduce((s, d) => s + d.swapCount, 0),
    btcdVolume: daily.reduce((s, d) => s + d.btcdVolume, 0),
    usdtVolume: daily.reduce((s, d) => s + d.usdtVolume, 0),
    btcdToUsdtVolume: daily.reduce((s, d) => s + d.btcdToUsdtBtcd, 0),
    usdtToBtcdVolume: daily.reduce((s, d) => s + d.usdtToBtcdUsdt, 0),
    btcdToUsdtCount: daily.reduce((s, d) => s + d.btcdToUsdtCount, 0),
    usdtToBtcdCount: daily.reduce((s, d) => s + d.usdtToBtcdCount, 0),
    mintCount: daily.reduce((s, d) => s + d.mintCount, 0),
    mintBtcd: daily.reduce((s, d) => s + d.mintBtcd, 0),
    mintUsdt: daily.reduce((s, d) => s + d.mintUsdt, 0),
    burnCount: daily.reduce((s, d) => s + d.burnCount, 0),
    burnBtcd: daily.reduce((s, d) => s + d.burnBtcd, 0),
    burnUsdt: daily.reduce((s, d) => s + d.burnUsdt, 0)
  };

  return { daily, stats };
}

function printSummary(
  daily: DailyStats[],
  stats: Record<string, number>,
  excess?: ExcessWithdrawalStats
) {
  console.log(`\n===== BTCD/USDT 兑换池汇总 =====`);
  console.log(`Pair: ${PAIR_ADDRESS}`);
  console.log(`BTCD: ${BTCD_TOKEN_ADDRESS}`);
  console.log(`USDT: ${USDT_TOKEN_ADDRESS}`);
  console.log(`Swap 笔数: ${formatWithCommas(stats.swapCount, 0)}`);
  // console.log(`  BTCD 成交量: ${formatWithCommas(stats.btcdVolume, 2)}`);
  console.log(`  BTCD 成交量: ${formatWithCommas(stats.btcdToUsdtVolume, 2)}`);
  // console.log(`  USDT 成交量: ${formatWithCommas(stats.usdtVolume, 2)}`);
  console.log(`  USDT 成交量: ${formatWithCommas(stats.usdtToBtcdVolume, 2)}`);
  console.log(`  BTCD→USDT: ${formatWithCommas(stats.btcdToUsdtCount, 0)} 笔`);
  console.log(`  USDT→BTCD: ${formatWithCommas(stats.usdtToBtcdCount, 0)} 笔`);
  console.log(
    `加流动性: ${formatWithCommas(stats.mintCount, 0)} 笔 | BTCD ${formatWithCommas(stats.mintBtcd, 2)} | USDT ${formatWithCommas(stats.mintUsdt, 2)}`
  );
  console.log(
    `撤流动性: ${formatWithCommas(stats.burnCount, 0)} 笔 | BTCD ${formatWithCommas(stats.burnBtcd, 2)} | USDT ${formatWithCommas(stats.burnUsdt, 2)}`
  );
  if (excess) {
    console.log(
      `池级 Burn−Mint: BTCD ${formatWithCommas(excess.burnMinusMintBtcd, 2)} | USDT ${formatWithCommas(excess.burnMinusMintUsdt, 2)}`
    );
    console.log(
      `超额取出: ${excess.excessUserCount} 地址 | BTCD ${formatWithCommas(excess.excessBtcd, 2)} | USDT ${formatWithCommas(excess.excessUsdt, 2)}`
    );
  }

  const recent = daily.slice(-14);
  if (recent.length === 0) {
    console.log('\n暂无日统计数据');
    return;
  }

  console.log(`\n===== 最近 ${recent.length} 日明细 =====`);
  console.log(
    '日期'.padEnd(12) +
      'Swap'.padStart(6) +
      'BTCDToUsdtVol'.padStart(14) +
      'USDTToBtcdVol'.padStart(14) +
      'Mint'.padStart(6) +
      'MintUSDT'.padStart(12) +
      'Burn'.padStart(6) +
      'BurnUSDT'.padStart(12)
  );
  for (const d of recent) {
    console.log(
      d.date.padEnd(12) +
        String(d.swapCount).padStart(6) +
        formatWithCommas(d.btcdToUsdtBtcd, 2).padStart(14) +
        formatWithCommas(d.usdtToBtcdUsdt, 2).padStart(14) +
        String(d.mintCount).padStart(6) +
        formatWithCommas(d.mintUsdt, 2).padStart(12) +
        String(d.burnCount).padStart(6) +
        formatWithCommas(d.burnUsdt, 2).padStart(12)
    );
  }
}

/** 最近 14 日（与日明细同一窗口）按 USDT 金额从大到小取前 N 笔 Swap */
function printTopRecentSwaps(swaps: SwapRecord[], daily: DailyStats[], topN: number = 10) {
  const recentDays = daily.slice(-14);
  if (recentDays.length === 0 || swaps.length === 0) {
    console.log('\n最近 14 日无大额交易可显示');
    return;
  }

  const cutoff = recentDays[0].timestamp;
  const top = swaps
    .filter((s) => s.timestamp >= cutoff)
    .sort((a, b) => toNum(b.usdtAmount) - toNum(a.usdtAmount))
    .slice(0, topN);

  console.log(`\n===== 最近 ${recentDays.length} 日 USDT 金额 Top ${top.length} 交易 =====`);
  if (top.length === 0) {
    console.log('(无)');
    return;
  }

  console.log(
    '#'.padStart(3) +
      '时间'.padStart(16) +
      '方向'.padStart(12) +
      'USDT'.padStart(12) +
      'BTCD'.padStart(12) +
      '      用户' +
      '      Tx'
  );
  top.forEach((s, i) => {
    const dir = s.direction === 'btcd_to_usdt' ? 'BTCD→USDT' : 'USDT→BTCD';
    console.log(
      String(i + 1).padStart(3) +
        (s.timestampStr || '').padStart(22) +
        dir.padStart(12) +
        formatWithCommas(s.usdtAmount, 2).padStart(12) +
        formatWithCommas(s.btcdAmount, 2).padStart(12) +
        `  ${s.user}` +
        `  ${s.transactionHash}`
    );
  });
}

/** 全部 Swap 按 USDT 金额从大到小取前 N 笔 */
function printTopSwapsByUsdt(swaps: SwapRecord[], topN: number = 10) {
  const top = [...swaps]
    .sort((a, b) => toNum(b.usdtAmount) - toNum(a.usdtAmount))
    .slice(0, topN);

  console.log(`\n===== 全部 Swap USDT 金额 Top ${top.length} =====`);
  if (top.length === 0) {
    console.log('(无)');
    return;
  }

  console.log(
    '#'.padStart(3) +
      '时间'.padStart(16) +
      '方向'.padStart(12) +
      'USDT'.padStart(12) +
      'BTCD'.padStart(12) +
      '      用户' +
      '      Tx'
  );
  top.forEach((s, i) => {
    const dir = s.direction === 'btcd_to_usdt' ? 'BTCD→USDT' : 'USDT→BTCD';
    console.log(
      String(i + 1).padStart(3) +
        (s.timestampStr || '').padStart(22) +
        dir.padStart(12) +
        formatWithCommas(s.usdtAmount, 2).padStart(12) +
        formatWithCommas(s.btcdAmount, 2).padStart(12) +
        `  ${s.user}` +
        `  ${s.transactionHash}`
    );
  });
}

interface UserLiquidityAgg {
  user: string;
  mintUsdt: number;
  burnUsdt: number;
  mintBtcd: number;
  burnBtcd: number;
  mintCount: number;
  burnCount: number;
}

interface UserLiquidityNet extends UserLiquidityAgg {
  netUsdt: number;
  netBtcd: number;
  /** Burn 超出 Mint 的部分（仅正值） */
  excessUsdt: number;
  excessBtcd: number;
}

interface ExcessWithdrawalStats {
  /** Burn 总量 − Mint 总量（池级口径，可被仍留在池内的 LP 对冲） */
  burnMinusMintBtcd: number;
  burnMinusMintUsdt: number;
  /** 各用户 max(0, Burn−Mint) 之和：真正的超额取出 */
  excessBtcd: number;
  excessUsdt: number;
  excessUserCount: number;
  users: UserLiquidityNet[];
}

function aggregateUserLiquidity(
  mints: LiquidityRecord[],
  burns: LiquidityRecord[]
): UserLiquidityAgg[] {
  const map = new Map<string, UserLiquidityAgg>();

  const ensure = (user: string): UserLiquidityAgg => {
    const key = user || '(unknown)';
    let agg = map.get(key);
    if (!agg) {
      agg = {
        user: key,
        mintUsdt: 0,
        burnUsdt: 0,
        mintBtcd: 0,
        burnBtcd: 0,
        mintCount: 0,
        burnCount: 0
      };
      map.set(key, agg);
    }
    return agg;
  };

  for (const m of mints) {
    const agg = ensure(m.user);
    agg.mintUsdt += toNum(m.usdtAmount);
    agg.mintBtcd += toNum(m.btcdAmount);
    agg.mintCount += 1;
  }
  for (const b of burns) {
    const agg = ensure(b.user);
    agg.burnUsdt += toNum(b.usdtAmount);
    agg.burnBtcd += toNum(b.btcdAmount);
    agg.burnCount += 1;
  }

  return Array.from(map.values());
}

/**
 * 提供/取走流动性（含 Skipped 单边）：
 * 提供 = Mint + skipped In；取走 = Burn + skipped Out
 */
function aggregateUserLiquidityFlow(
  mints: LiquidityRecord[],
  burns: LiquidityRecord[],
  skipped: SkippedRecord[]
): UserLiquidityFlowAgg[] {
  const map = new Map<string, UserLiquidityFlowAgg>();

  const ensure = (user: string): UserLiquidityFlowAgg => {
    const key = user || '(unknown)';
    let agg = map.get(key);
    if (!agg) {
      agg = {
        user: key,
        provideBtcd: 0,
        provideUsdt: 0,
        provideCount: 0,
        withdrawBtcd: 0,
        withdrawUsdt: 0,
        withdrawCount: 0,
        mintBtcd: 0,
        mintUsdt: 0,
        skipInBtcd: 0,
        skipInUsdt: 0,
        burnBtcd: 0,
        burnUsdt: 0,
        skipOutBtcd: 0,
        skipOutUsdt: 0
      };
      map.set(key, agg);
    }
    return agg;
  };

  for (const m of mints) {
    const agg = ensure(m.user);
    const btcd = toNum(m.btcdAmount);
    const usdt = toNum(m.usdtAmount);
    agg.mintBtcd += btcd;
    agg.mintUsdt += usdt;
    agg.provideBtcd += btcd;
    agg.provideUsdt += usdt;
    agg.provideCount += 1;
  }
  for (const b of burns) {
    const agg = ensure(b.user);
    const btcd = toNum(b.btcdAmount);
    const usdt = toNum(b.usdtAmount);
    agg.burnBtcd += btcd;
    agg.burnUsdt += usdt;
    agg.withdrawBtcd += btcd;
    agg.withdrawUsdt += usdt;
    agg.withdrawCount += 1;
  }
  for (const s of skipped) {
    const bi = toNum(s.btcdIn);
    const ui = toNum(s.usdtIn);
    const bo = toNum(s.btcdOut);
    const uo = toNum(s.usdtOut);
    if (bi === 0 && ui === 0 && bo === 0 && uo === 0) continue;
    const agg = ensure(s.user);
    if (bi > 0 || ui > 0) {
      agg.skipInBtcd += bi;
      agg.skipInUsdt += ui;
      agg.provideBtcd += bi;
      agg.provideUsdt += ui;
      agg.provideCount += 1;
    }
    if (bo > 0 || uo > 0) {
      agg.skipOutBtcd += bo;
      agg.skipOutUsdt += uo;
      agg.withdrawBtcd += bo;
      agg.withdrawUsdt += uo;
      agg.withdrawCount += 1;
    }
  }

  return Array.from(map.values());
}

function aggregateUserSwaps(swaps: SwapRecord[]): UserSwapAgg[] {
  const map = new Map<string, UserSwapAgg>();
  for (const sw of swaps) {
    const key = sw.user || '(unknown)';
    let agg = map.get(key);
    if (!agg) {
      agg = {
        user: key,
        swapCount: 0,
        btcdVolume: 0,
        usdtVolume: 0,
        btcdToUsdtUsdt: 0,
        usdtToBtcdUsdt: 0,
        netUsdt: 0
      };
      map.set(key, agg);
    }
    const btcd = toNum(sw.btcdAmount);
    const usdt = toNum(sw.usdtAmount);
    agg.swapCount += 1;
    agg.btcdVolume += btcd;
    agg.usdtVolume += usdt;
    if (sw.direction === 'btcd_to_usdt') {
      agg.btcdToUsdtUsdt += usdt;
      agg.netUsdt += usdt;
    } else {
      agg.usdtToBtcdUsdt += usdt;
      agg.netUsdt -= usdt;
    }
  }
  return Array.from(map.values());
}

function printUserFlowRanking(
  title: string,
  rows: UserLiquidityFlowAgg[],
  sortKey: 'provideBtcd' | 'provideUsdt' | 'withdrawBtcd' | 'withdrawUsdt',
  topN: number
): UserLiquidityFlowAgg[] {
  const isProvide = sortKey.startsWith('provide');
  const top = [...rows]
    .filter((r) => (isProvide ? r.provideBtcd + r.provideUsdt : r.withdrawBtcd + r.withdrawUsdt) > 0)
    .sort((a, b) => b[sortKey] - a[sortKey])
    .slice(0, topN);

  console.log(`\n===== ${title} Top ${top.length} =====`);
  if (top.length === 0) {
    console.log('(无)');
    return top;
  }

  console.log(
    '#'.padStart(3) +
      'BTCD'.padStart(14) +
      'USDT'.padStart(14) +
      '笔数'.padStart(6) +
      '      用户'
  );
  top.forEach((a, i) => {
    const btcd = isProvide ? a.provideBtcd : a.withdrawBtcd;
    const usdt = isProvide ? a.provideUsdt : a.withdrawUsdt;
    const count = isProvide ? a.provideCount : a.withdrawCount;
    console.log(
      String(i + 1).padStart(3) +
        formatWithCommas(btcd, 2).padStart(14) +
        formatWithCommas(usdt, 2).padStart(14) +
        String(count).padStart(6) +
        `  ${a.user}`
    );
  });
  return top;
}

function printTopSwapUsers(
  swaps: SwapRecord[],
  topN: number = 20,
  opts?: { direction?: 'btcd_to_usdt' | 'usdt_to_btcd'; title?: string }
): UserSwapAgg[] {
  const filtered = opts?.direction
    ? swaps.filter((s) => s.direction === opts.direction)
    : swaps;
  const top = aggregateUserSwaps(filtered)
    .sort((a, b) => b.usdtVolume - a.usdtVolume)
    .slice(0, topN);

  const title = opts?.title || '用户 Swap 总量';
  console.log(`\n===== ${title} Top ${top.length} =====`);
  if (top.length === 0) {
    console.log('(无)');
    return top;
  }

  console.log(
    '#'.padStart(3) +
      'USDT'.padStart(14) +
      'BTCD'.padStart(14) +
      '笔数'.padStart(8) +
      '      用户'
  );
  top.forEach((a, i) => {
    console.log(
      String(i + 1).padStart(3) +
        formatWithCommas(a.usdtVolume, 2).padStart(14) +
        formatWithCommas(a.btcdVolume, 2).padStart(14) +
        String(a.swapCount).padStart(8) +
        `  ${a.user}`
    );
  });
  return top;
}

/** 净兑换 USDT：BTCD→USDT 为正，USDT→BTCD 为负；ascending=true 为倒数（最负） */
function printTopSwapNetUsdtUsers(
  swaps: SwapRecord[],
  topN: number = 20,
  ascending: boolean = false
): UserSwapAgg[] {
  const top = aggregateUserSwaps(swaps)
    .sort((a, b) => (ascending ? a.netUsdt - b.netUsdt : b.netUsdt - a.netUsdt))
    .slice(0, topN);

  const label = ascending ? '倒数 Top' : 'Top';
  console.log(`\n===== 用户 Swap 净兑换(USDT) ${label} ${top.length} =====`);
  console.log(`口径: BTCD→USDT 为正，USDT→BTCD 为负；净额=兑出USDT − 兑入USDT`);
  if (top.length === 0) {
    console.log('(无)');
    return top;
  }

  console.log(
    '#'.padStart(3) +
      '净USDT'.padStart(14) +
      'BTCD→USDT'.padStart(14) +
      'USDT→BTCD'.padStart(14) +
      '笔数'.padStart(8) +
      '      用户'
  );
  top.forEach((a, i) => {
    console.log(
      String(i + 1).padStart(3) +
        formatWithCommas(a.netUsdt, 2).padStart(14) +
        formatWithCommas(a.btcdToUsdtUsdt, 2).padStart(14) +
        formatWithCommas(a.usdtToBtcdUsdt, 2).padStart(14) +
        String(a.swapCount).padStart(8) +
        `  ${a.user}`
    );
  });
  return top;
}

/** 提供/取走（含 Skipped）+ Swap 用户排行 */
function printUserRankings(
  mints: LiquidityRecord[],
  burns: LiquidityRecord[],
  skipped: SkippedRecord[],
  swaps: SwapRecord[],
  topN: number = 20
): UserRankingsFile {
  const flows = aggregateUserLiquidityFlow(mints, burns, skipped);
  return {
    provideByBtcd: printUserFlowRanking(
      '提供流动性(含Skipped单边入金) 按BTCD',
      flows,
      'provideBtcd',
      topN
    ),
    provideByUsdt: printUserFlowRanking(
      '提供流动性(含Skipped单边入金) 按USDT',
      flows,
      'provideUsdt',
      topN
    ),
    withdrawByBtcd: printUserFlowRanking(
      '取走流动性(含Skipped单边出金) 按BTCD',
      flows,
      'withdrawBtcd',
      topN
    ),
    withdrawByUsdt: printUserFlowRanking(
      '取走流动性(含Skipped单边出金) 按USDT',
      flows,
      'withdrawUsdt',
      topN
    ),
    swapByUsdt: printTopSwapUsers(swaps, topN),
    swapNetUsdt: printTopSwapNetUsdtUsers(swaps, 50, false),
    swapNetUsdtBottom: printTopSwapNetUsdtUsers(swaps, topN, true),
    swapBtcdToUsdt: printTopSwapUsers(swaps, topN, {
      direction: 'btcd_to_usdt',
      title: '用户 Swap BTCD→USDT'
    }),
    swapUsdtToBtcd: printTopSwapUsers(swaps, topN, {
      direction: 'usdt_to_btcd',
      title: '用户 Swap USDT→BTCD'
    })
  };
}

function toUserLiquidityNet(a: UserLiquidityAgg): UserLiquidityNet {
  const netUsdt = a.mintUsdt - a.burnUsdt;
  const netBtcd = a.mintBtcd - a.burnBtcd;
  return {
    ...a,
    netUsdt,
    netBtcd,
    excessUsdt: Math.max(0, -netUsdt),
    excessBtcd: Math.max(0, -netBtcd)
  };
}

/** 超额取出：用户累计 Burn > Mint 的部分（按用户独立计算后加总） */
function computeExcessWithdrawal(
  mints: LiquidityRecord[],
  burns: LiquidityRecord[]
): ExcessWithdrawalStats {
  const users = aggregateUserLiquidity(mints, burns).map(toUserLiquidityNet);
  const mintBtcd = users.reduce((s, u) => s + u.mintBtcd, 0);
  const mintUsdt = users.reduce((s, u) => s + u.mintUsdt, 0);
  const burnBtcd = users.reduce((s, u) => s + u.burnBtcd, 0);
  const burnUsdt = users.reduce((s, u) => s + u.burnUsdt, 0);
  const excessUsers = users.filter((u) => u.excessBtcd > 0 || u.excessUsdt > 0);

  return {
    burnMinusMintBtcd: burnBtcd - mintBtcd,
    burnMinusMintUsdt: burnUsdt - mintUsdt,
    excessBtcd: excessUsers.reduce((s, u) => s + u.excessBtcd, 0),
    excessUsdt: excessUsers.reduce((s, u) => s + u.excessUsdt, 0),
    excessUserCount: excessUsers.length,
    users
  };
}

/** 按用户聚合 Mint - Burn 净流动性，按净 USDT 降序取前 N */
function printTopNetLiquidityUsers(
  mints: LiquidityRecord[],
  burns: LiquidityRecord[],
  topN: number = 10
) {
  const top = aggregateUserLiquidity(mints, burns)
    .map(toUserLiquidityNet)
    .sort((a, b) => b.netUsdt - a.netUsdt)
    .slice(0, topN);

  console.log(`\n===== 用户净流动性 Top ${top.length} (Mint - Burn) =====`);
  if (top.length === 0) {
    console.log('(无)');
    return;
  }

  console.log(
    '#'.padStart(3) +
      '净USDT'.padStart(14) +
      '净BTCD'.padStart(14) +
      'Mint'.padStart(6) +
      'Burn'.padStart(6) +
      '      用户'
  );
  top.forEach((a, i) => {
    console.log(
      String(i + 1).padStart(3) +
        formatWithCommas(a.netUsdt, 2).padStart(14) +
        formatWithCommas(a.netBtcd, 2).padStart(14) +
        String(a.mintCount).padStart(6) +
        String(a.burnCount).padStart(6) +
        `  ${a.user}`
    );
  });
}

/**
 * 超额取出：用户 Burn > Mint 的差额。
 * 池级 Burn−Mint 会被「仍留在池内的 LP」对冲；超额取出按用户独立加总，更能反映运营/做市超额提取。
 */
function printExcessWithdrawals(
  mints: LiquidityRecord[],
  burns: LiquidityRecord[],
  topN: number = 10
): ExcessWithdrawalStats {
  const stats = computeExcessWithdrawal(mints, burns);
  const top = [...stats.users]
    .filter((u) => u.excessBtcd > 0 || u.excessUsdt > 0)
    .sort((a, b) => b.excessBtcd - a.excessBtcd || b.excessUsdt - a.excessUsdt)
    .slice(0, topN);

  console.log(`\n===== 超额取出 (Burn > Mint) =====`);
  console.log(
    `池级 Burn−Mint: BTCD ${formatWithCommas(stats.burnMinusMintBtcd, 2)} | USDT ${formatWithCommas(stats.burnMinusMintUsdt, 2)}`
  );
  console.log(
    `用户超额合计: BTCD ${formatWithCommas(stats.excessBtcd, 2)} | USDT ${formatWithCommas(stats.excessUsdt, 2)} | ${stats.excessUserCount} 个地址`
  );

  if (top.length === 0) {
    console.log('(无超额取出用户)');
    return stats;
  }

  console.log(`\n===== 超额取出 Top ${top.length} =====`);
  console.log(
    '#'.padStart(3) +
      '超额BTCD'.padStart(14) +
      '超额USDT'.padStart(14) +
      'MintBTCD'.padStart(14) +
      'BurnBTCD'.padStart(14) +
      'Mint'.padStart(6) +
      'Burn'.padStart(6) +
      '      用户'
  );
  top.forEach((a, i) => {
    console.log(
      String(i + 1).padStart(3) +
        formatWithCommas(a.excessBtcd, 2).padStart(14) +
        formatWithCommas(a.excessUsdt, 2).padStart(14) +
        formatWithCommas(a.mintBtcd, 2).padStart(14) +
        formatWithCommas(a.burnBtcd, 2).padStart(14) +
        String(a.mintCount).padStart(6) +
        String(a.burnCount).padStart(6) +
        `  ${a.user}`
    );
  });

  return stats;
}

function printTopLiquidityByUsdt(
  records: LiquidityRecord[],
  label: string,
  topN: number = 10
) {
  const top = [...records]
    .sort((a, b) => toNum(b.usdtAmount) - toNum(a.usdtAmount))
    .slice(0, topN);

  console.log(`\n===== ${label} USDT 金额 Top ${top.length} =====`);
  if (top.length === 0) {
    console.log('(无)');
    return;
  }

  console.log(
    '#'.padStart(3) +
      '时间'.padStart(16) +
      'USDT'.padStart(12) +
      'BTCD'.padStart(12) +
      '      用户' +
      '      Tx'
  );
  top.forEach((r, i) => {
    console.log(
      String(i + 1).padStart(3) +
        (r.timestampStr || '').padStart(22) +
        formatWithCommas(r.usdtAmount, 2).padStart(12) +
        formatWithCommas(r.btcdAmount, 2).padStart(12) +
        `  ${r.user || '(unknown)'}` +
        `  ${r.transactionHash}`
    );
  });
}

function printTopMintsByUsdt(mints: LiquidityRecord[], topN: number = 10) {
  printTopLiquidityByUsdt(mints, 'Mint', topN);
}

function printTopBurnsByUsdt(burns: LiquidityRecord[], topN: number = 10) {
  printTopLiquidityByUsdt(burns, 'Burn', topN);
}

function summarizeSkipped(skipped: SkippedRecord[]) {
  const byPattern = new Map<string, { count: number; btcdIn: number; btcdOut: number; usdtIn: number; usdtOut: number }>();
  let btcdIn = 0;
  let btcdOut = 0;
  let usdtIn = 0;
  let usdtOut = 0;

  for (const s of skipped) {
    const bi = toNum(s.btcdIn);
    const bo = toNum(s.btcdOut);
    const ui = toNum(s.usdtIn);
    const uo = toNum(s.usdtOut);
    btcdIn += bi;
    btcdOut += bo;
    usdtIn += ui;
    usdtOut += uo;
    let p = byPattern.get(s.pattern);
    if (!p) {
      p = { count: 0, btcdIn: 0, btcdOut: 0, usdtIn: 0, usdtOut: 0 };
      byPattern.set(s.pattern, p);
    }
    p.count += 1;
    p.btcdIn += bi;
    p.btcdOut += bo;
    p.usdtIn += ui;
    p.usdtOut += uo;
  }

  return {
    count: skipped.length,
    btcdIn,
    btcdOut,
    usdtIn,
    usdtOut,
    btcdNet: btcdIn - btcdOut,
    usdtNet: usdtIn - usdtOut,
    byPattern
  };
}

/** 隐含余额 = Mint − Burn + Swap净流入（可选 + Skipped净流入） */
function computeImpliedBalances(
  swaps: SwapRecord[],
  mints: LiquidityRecord[],
  burns: LiquidityRecord[],
  skipped: SkippedRecord[]
) {
  const mintBtcd = mints.reduce((s, m) => s + toNum(m.btcdAmount), 0);
  const mintUsdt = mints.reduce((s, m) => s + toNum(m.usdtAmount), 0);
  const burnBtcd = burns.reduce((s, b) => s + toNum(b.btcdAmount), 0);
  const burnUsdt = burns.reduce((s, b) => s + toNum(b.usdtAmount), 0);

  let swapBtcdIn = 0;
  let swapBtcdOut = 0;
  let swapUsdtIn = 0;
  let swapUsdtOut = 0;
  for (const sw of swaps) {
    if (sw.direction === 'btcd_to_usdt') {
      swapBtcdIn += toNum(sw.btcdAmount);
      swapUsdtOut += toNum(sw.usdtAmount);
    } else {
      swapUsdtIn += toNum(sw.usdtAmount);
      swapBtcdOut += toNum(sw.btcdAmount);
    }
  }

  const skip = summarizeSkipped(skipped);
  const impliedBtcd = mintBtcd - burnBtcd + swapBtcdIn - swapBtcdOut;
  const impliedUsdt = mintUsdt - burnUsdt + swapUsdtIn - swapUsdtOut;

  return {
    mintBtcd,
    mintUsdt,
    burnBtcd,
    burnUsdt,
    swapBtcdIn,
    swapBtcdOut,
    swapUsdtIn,
    swapUsdtOut,
    swapBtcdNet: swapBtcdIn - swapBtcdOut,
    swapUsdtNet: swapUsdtIn - swapUsdtOut,
    skipped: skip,
    impliedBtcd,
    impliedUsdt,
    impliedWithSkippedBtcd: impliedBtcd + skip.btcdNet,
    impliedWithSkippedUsdt: impliedUsdt + skip.usdtNet
  };
}

async function fetchPairOnchainBalances(provider: any): Promise<{ btcd: number; usdt: number }> {
  const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
  const btcd = new ethers.Contract(BTCD_TOKEN_ADDRESS, erc20Abi, provider);
  const usdt = new ethers.Contract(USDT_TOKEN_ADDRESS, erc20Abi, provider);
  const [btcdRaw, usdtRaw] = await Promise.all([
    btcd.balanceOf(PAIR_ADDRESS),
    usdt.balanceOf(PAIR_ADDRESS)
  ]);
  return {
    btcd: toNum(formatAmt(btcdRaw)),
    usdt: toNum(formatAmt(usdtRaw))
  };
}

function printSkippedInflows(skipped: SkippedRecord[], topN: number = 15) {
  const sum = summarizeSkipped(skipped);
  console.log(`\n===== Skipped 入金/出金汇总 (${sum.count} 笔) =====`);
  if (sum.count === 0) {
    console.log('(无 skipped；若刚升级脚本请用 --rescan-events 全量重扫)');
    return sum;
  }

  console.log(
    `BTCD 入 ${formatWithCommas(sum.btcdIn, 2)} / 出 ${formatWithCommas(sum.btcdOut, 2)} / 净 ${formatWithCommas(sum.btcdNet, 2)}`
  );
  console.log(
    `USDT 入 ${formatWithCommas(sum.usdtIn, 2)} / 出 ${formatWithCommas(sum.usdtOut, 2)} / 净 ${formatWithCommas(sum.usdtNet, 2)}`
  );

  console.log('\n按 pattern:');
  const patterns = Array.from(sum.byPattern.entries()).sort(
    (a, b) => b[1].btcdIn + b[1].usdtIn - (a[1].btcdIn + a[1].usdtIn)
  );
  for (const [pattern, p] of patterns) {
    console.log(
      `  ${pattern.padEnd(28)} ${String(p.count).padStart(5)} 笔` +
        ` | BTCD净 ${formatWithCommas(p.btcdIn - p.btcdOut, 2).padStart(14)}` +
        ` | USDT净 ${formatWithCommas(p.usdtIn - p.usdtOut, 2).padStart(14)}` +
        ` | 入BTCD ${formatWithCommas(p.btcdIn, 2).padStart(12)}` +
        ` 入USDT ${formatWithCommas(p.usdtIn, 2).padStart(12)}`
    );
  }

  const inflowish = [...skipped]
    .filter((s) => toNum(s.btcdIn) + toNum(s.usdtIn) > 0)
    .sort(
      (a, b) =>
        toNum(b.btcdIn) + toNum(b.usdtIn) - (toNum(a.btcdIn) + toNum(a.usdtIn))
    )
    .slice(0, topN);

  if (inflowish.length > 0) {
    console.log(`\n===== Skipped 入金金额 Top ${inflowish.length} =====`);
    console.log(
      '#'.padStart(3) +
        '时间'.padStart(16) +
        'pattern'.padStart(22) +
        'BTCD入'.padStart(12) +
        'USDT入'.padStart(12) +
        'BTCD出'.padStart(12) +
        'USDT出'.padStart(12) +
        '      用户'
    );
    inflowish.forEach((s, i) => {
      console.log(
        String(i + 1).padStart(3) +
          (s.timestampStr || '').padStart(22) +
          s.pattern.padStart(22) +
          formatWithCommas(s.btcdIn, 2).padStart(12) +
          formatWithCommas(s.usdtIn, 2).padStart(12) +
          formatWithCommas(s.btcdOut, 2).padStart(12) +
          formatWithCommas(s.usdtOut, 2).padStart(12) +
          `  ${s.user || '(unknown)'}  ${s.transactionHash}`
      );
    });
  }

  return sum;
}

async function printBalanceReconcile(
  provider: any,
  swaps: SwapRecord[],
  mints: LiquidityRecord[],
  burns: LiquidityRecord[],
  skipped: SkippedRecord[]
): Promise<BalanceReconcileStats> {
  const implied = computeImpliedBalances(swaps, mints, burns, skipped);
  const onchain = await fetchPairOnchainBalances(provider);

  const gapBtcd = onchain.btcd - implied.impliedBtcd;
  const gapUsdt = onchain.usdt - implied.impliedUsdt;
  const gapWithSkippedBtcd = onchain.btcd - implied.impliedWithSkippedBtcd;
  const gapWithSkippedUsdt = onchain.usdt - implied.impliedWithSkippedUsdt;

  console.log(`\n===== Pair 余额对账 =====`);
  console.log(
    `链上余额:     BTCD ${formatWithCommas(onchain.btcd, 2)} | USDT ${formatWithCommas(onchain.usdt, 2)}`
  );
  console.log(
    `隐含(分类内): BTCD ${formatWithCommas(implied.impliedBtcd, 2)} | USDT ${formatWithCommas(implied.impliedUsdt, 2)}` +
      `  (= Mint−Burn+Swap净)`
  );
  console.log(
    `缺口(链上−隐含): BTCD ${formatWithCommas(gapBtcd, 2)} | USDT ${formatWithCommas(gapUsdt, 2)}`
  );
  console.log(
    `隐含(+Skipped): BTCD ${formatWithCommas(implied.impliedWithSkippedBtcd, 2)} | USDT ${formatWithCommas(implied.impliedWithSkippedUsdt, 2)}`
  );
  console.log(
    `缺口(+Skipped后): BTCD ${formatWithCommas(gapWithSkippedBtcd, 2)} | USDT ${formatWithCommas(gapWithSkippedUsdt, 2)}`
  );
  console.log(
    `分解: Mint BTCD ${formatWithCommas(implied.mintBtcd, 2)} − Burn ${formatWithCommas(implied.burnBtcd, 2)}` +
      ` + Swap净 ${formatWithCommas(implied.swapBtcdNet, 2)}` +
      ` + Skipped净 ${formatWithCommas(implied.skipped.btcdNet, 2)}`
  );
  console.log(
    `      Mint USDT ${formatWithCommas(implied.mintUsdt, 2)} − Burn ${formatWithCommas(implied.burnUsdt, 2)}` +
      ` + Swap净 ${formatWithCommas(implied.swapUsdtNet, 2)}` +
      ` + Skipped净 ${formatWithCommas(implied.skipped.usdtNet, 2)}`
  );

  if (skipped.length === 0) {
    console.log(`提示: 无 skipped 明细时「+Skipped」与分类内相同；请用 --rescan-events 全量重建`);
  }

  return {
    onchainBtcd: onchain.btcd,
    onchainUsdt: onchain.usdt,
    impliedBtcd: implied.impliedBtcd,
    impliedUsdt: implied.impliedUsdt,
    impliedWithSkippedBtcd: implied.impliedWithSkippedBtcd,
    impliedWithSkippedUsdt: implied.impliedWithSkippedUsdt,
    gapBtcd,
    gapUsdt,
    gapWithSkippedBtcd,
    gapWithSkippedUsdt,
    skippedCount: implied.skipped.count,
    skippedBtcdIn: implied.skipped.btcdIn,
    skippedBtcdOut: implied.skipped.btcdOut,
    skippedUsdtIn: implied.skipped.usdtIn,
    skippedUsdtOut: implied.skipped.usdtOut,
    skippedBtcdNet: implied.skipped.btcdNet,
    skippedUsdtNet: implied.skipped.usdtNet
  };
}

function loadExisting(): Partial<PairStatsFile> & {
  mints: LiquidityRecord[];
  burns: LiquidityRecord[];
  skipped: SkippedRecord[];
} | null {
  if (!fs.existsSync(OUTPUT_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8')) as PairStatsFile;
    let mints = data.mints || [];
    let burns = data.burns || [];
    let skipped: SkippedRecord[] = [];
    if (fs.existsSync(LIQUIDITY_OUTPUT_FILE)) {
      try {
        const liq = JSON.parse(fs.readFileSync(LIQUIDITY_OUTPUT_FILE, 'utf-8')) as LiquidityFile;
        if (Array.isArray(liq.mints)) mints = liq.mints;
        if (Array.isArray(liq.burns)) burns = liq.burns;
        if (Array.isArray(liq.skipped)) skipped = liq.skipped;
      } catch {
        // 流动性文件损坏时回退主文件内嵌数据
      }
    }
    return { ...data, mints, burns, skipped };
  } catch {
    return null;
  }
}

async function main() {
  const { update, rescanEvents } = parseArgs();
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

  const startTime = Date.now();

  console.log(`网络: ${network}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Pair: ${PAIR_ADDRESS}`);
  console.log(`BTCD: ${BTCD_TOKEN_ADDRESS}`);
  console.log(`USDT: ${USDT_TOKEN_ADDRESS}`);

  let swaps: SwapRecord[] = [];
  let mints: LiquidityRecord[] = [];
  let burns: LiquidityRecord[] = [];
  let skipped: SkippedRecord[] = [];
  let lastBlock = 0;

  if (!update) {
    const existing = loadExisting();
    if (!existing || (!existing.swaps?.length && !existing.mints?.length && !existing.burns?.length)) {
      console.error(
        `\n--no-update 需要已有非空数据文件: ${OUTPUT_FILE}\n请先不带 --no-update 运行一次。`
      );
      process.exit(1);
    }
    console.log(`\n跳过链上更新，使用已有数据 (--no-update)`);
    swaps = existing.swaps || [];
    mints = existing.mints || [];
    burns = existing.burns || [];
    skipped = existing.skipped || [];
    lastBlock = existing.lastBlock || 0;
    const { daily, stats } = computeDailyAndTotals(swaps, mints, burns);
    printTopNetLiquidityUsers(mints, burns, 500);
    const excess = printExcessWithdrawals(mints, burns);
    printUserRankings(mints, burns, skipped, swaps);
    printSkippedInflows(skipped);
    await printBalanceReconcile(provider, swaps, mints, burns, skipped);
    printTopMintsByUsdt(mints);
    printTopBurnsByUsdt(burns);
    printTopSwapsByUsdt(swaps);
    printSummary(daily, stats, excess);
    printTopRecentSwaps(swaps, daily);
    console.log(`\n--no-update：未写入 ${OUTPUT_FILE} / ${LIQUIDITY_OUTPUT_FILE}`);
    return;
  }

  const currentBlock = await provider.getBlockNumber();
  console.log(`当前区块: ${currentBlock}`);

  const existing = loadExisting();
  let existingSwaps: SwapRecord[] = [];
  let existingMints: LiquidityRecord[] = [];
  let existingBurns: LiquidityRecord[] = [];
  let existingSkipped: SkippedRecord[] = [];
  let startBlock = INITIAL_START_BLOCK;

  if (existing && !rescanEvents) {
    existingSwaps = existing.swaps || [];
    existingMints = existing.mints || [];
    existingBurns = existing.burns || [];
    existingSkipped = existing.skipped || [];
    if (typeof existing.lastBlock === 'number' && existing.lastBlock >= INITIAL_START_BLOCK) {
      startBlock = existing.lastBlock + 1;
    }
    console.log(
      `增量模式：已有 Swap ${existingSwaps.length} / Mint ${existingMints.length} / Burn ${existingBurns.length}` +
        ` / Skipped ${existingSkipped.length}，从区块 ${startBlock} 继续`
    );
    if (existingSkipped.length === 0) {
      console.log(`提示: 尚无 skipped 历史，建议加 --rescan-events 全量重扫以重建对账数据`);
    }
  } else if (rescanEvents) {
    console.log(`--rescan-events：从 start_block ${INITIAL_START_BLOCK} 全量重扫`);
    startBlock = INITIAL_START_BLOCK;
  }

  if (startBlock > currentBlock) {
    console.log(`已同步到最新 (lastBlock=${existing?.lastBlock}, current=${currentBlock})`);
    swaps = existingSwaps;
    mints = existingMints;
    burns = existingBurns;
    skipped = existingSkipped;
    lastBlock = existing?.lastBlock || currentBlock;
  } else {
    console.log(`\n并行拉取 BTCD / USDT Transfer (涉及 Pair)...`);
    const [btcdLogs, usdtLogs] = await Promise.all([
      fetchTokenTransfersInvolvingPair(
        provider,
        BTCD_TOKEN_ADDRESS,
        startBlock,
        currentBlock,
        'BTCD'
      ),
      fetchTokenTransfersInvolvingPair(
        provider,
        USDT_TOKEN_ADDRESS,
        startBlock,
        currentBlock,
        'USDT'
      )
    ]);
    console.log(`BTCD 相关 Transfer: ${btcdLogs.length}`);
    console.log(`USDT 相关 Transfer: ${usdtLogs.length}`);

    const flows = buildTxFlows(btcdLogs, usdtLogs);
    console.log(`涉及 Pair 的交易数: ${flows.size}`);

    const blockNumbers = [...new Set([...flows.values()].map((f) => f.blockNumber))];
    console.log(`获取 ${blockNumbers.length} 个区块时间戳...`);
    const blockTimestamps = await getBlockTimestamps(blockNumbers, RPC_URL);

    const decoded = classifyFlows(flows, blockTimestamps);
    console.log(
      `分类: Swap ${decoded.swaps.length}, Mint ${decoded.mints.length}, Burn ${decoded.burns.length}, Skipped ${decoded.skipped.length}`
    );

    if (rescanEvents) {
      swaps = decoded.swaps;
      mints = decoded.mints;
      burns = decoded.burns;
      skipped = decoded.skipped;
    } else {
      swaps = mergeByTxHash(existingSwaps, decoded.swaps);
      mints = mergeByTxHash(existingMints, decoded.mints);
      burns = mergeByTxHash(existingBurns, decoded.burns);
      skipped = mergeByTxHash(existingSkipped, decoded.skipped);
    }
    lastBlock = currentBlock;
    console.log(
      `合并后: Swap ${swaps.length}, Mint ${mints.length}, Burn ${burns.length}, Skipped ${skipped.length}`
    );
  }

  const { daily, stats } = computeDailyAndTotals(swaps, mints, burns);
  printTopNetLiquidityUsers(mints, burns);
  const excess = printExcessWithdrawals(mints, burns);
  const rankings = printUserRankings(mints, burns, skipped, swaps);
  printSkippedInflows(skipped);
  const reconcile = await printBalanceReconcile(provider, swaps, mints, burns, skipped);
  printTopMintsByUsdt(mints);
  printTopBurnsByUsdt(burns);
  printTopSwapsByUsdt(swaps);
  printSummary(daily, stats, excess);
  printTopRecentSwaps(swaps, daily);

  const output: PairStatsFile = {
    lastBlock,
    pair: PAIR_ADDRESS,
    btcdToken: BTCD_TOKEN_ADDRESS,
    usdtToken: USDT_TOKEN_ADDRESS,
    stats: {
      ...stats,
      burnMinusMintBtcd: excess.burnMinusMintBtcd,
      burnMinusMintUsdt: excess.burnMinusMintUsdt,
      excessBtcd: excess.excessBtcd,
      excessUsdt: excess.excessUsdt,
      excessUserCount: excess.excessUserCount,
      onchainBtcd: reconcile.onchainBtcd,
      onchainUsdt: reconcile.onchainUsdt,
      impliedBtcd: reconcile.impliedBtcd,
      impliedUsdt: reconcile.impliedUsdt,
      impliedWithSkippedBtcd: reconcile.impliedWithSkippedBtcd,
      impliedWithSkippedUsdt: reconcile.impliedWithSkippedUsdt,
      gapBtcd: reconcile.gapBtcd,
      gapUsdt: reconcile.gapUsdt,
      skippedCount: reconcile.skippedCount,
      skippedBtcdNet: reconcile.skippedBtcdNet,
      skippedUsdtNet: reconcile.skippedUsdtNet
    },
    daily,
    swaps
  };

  const excessUsers = excess.users
    .filter((u) => u.excessBtcd > 0 || u.excessUsdt > 0)
    .sort((a, b) => b.excessBtcd - a.excessBtcd || b.excessUsdt - a.excessUsdt)
    .map((u) => ({
      user: u.user,
      mintBtcd: u.mintBtcd,
      burnBtcd: u.burnBtcd,
      mintUsdt: u.mintUsdt,
      burnUsdt: u.burnUsdt,
      excessBtcd: u.excessBtcd,
      excessUsdt: u.excessUsdt,
      mintCount: u.mintCount,
      burnCount: u.burnCount
    }));

  const liquidityOutput: LiquidityFile = {
    pair: PAIR_ADDRESS,
    btcdToken: BTCD_TOKEN_ADDRESS,
    usdtToken: USDT_TOKEN_ADDRESS,
    mints,
    burns,
    skipped,
    excessWithdrawal: {
      burnMinusMintBtcd: excess.burnMinusMintBtcd,
      burnMinusMintUsdt: excess.burnMinusMintUsdt,
      excessBtcd: excess.excessBtcd,
      excessUsdt: excess.excessUsdt,
      excessUserCount: excess.excessUserCount,
      users: excessUsers
    },
    balanceReconcile: reconcile,
    rankings
  };

  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  fs.writeFileSync(LIQUIDITY_OUTPUT_FILE, JSON.stringify(liquidityOutput, null, 2));
  console.log(`\n已保存到 ${OUTPUT_FILE}`);
  console.log(`流动性明细已保存到 ${LIQUIDITY_OUTPUT_FILE}`);
  console.log(`最后区块: ${lastBlock}`);

  // 显示脚本执行总时间
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`✨总耗时: ${duration.toFixed(2)} 秒`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
