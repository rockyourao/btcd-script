/**
 * BTCD/USDT 自定义兑换合约日统计（非 Uniswap V2 Pair）
 *
 * 合约 0xFF60...497F：1:1 兑换池。Swap / 加流动性有合约事件，撤流动性无事件。
 * 本脚本通过 BTCD / USDT 相对该合约的 Transfer 按交易分类：
 *   - Swap: 单边转入 + 另一边转出
 *   - Mint(加流动性): 同时转入 BTCD + USDT
 *   - Burn(撤流动性): 同时转出 BTCD + USDT
 *
 * 使用方法:
 * npx ts-node btcdUsdtPairStats.ts
 * npx ts-node btcdUsdtPairStats.ts --network pgp-prod
 * npx ts-node btcdUsdtPairStats.ts --no-update
 * npx ts-node btcdUsdtPairStats.ts --rescan-events
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

interface LiquidityFile {
  pair: string;
  btcdToken: string;
  usdtToken: string;
  mints: LiquidityRecord[];
  burns: LiquidityRecord[];
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

function classifyFlows(
  flows: Map<string, TxFlow>,
  blockTimestamps: Map<number, number>
): { swaps: SwapRecord[]; mints: LiquidityRecord[]; burns: LiquidityRecord[]; skipped: number } {
  const swaps: SwapRecord[] = [];
  const mints: LiquidityRecord[] = [];
  const burns: LiquidityRecord[] = [];
  let skipped = 0;

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

    skipped += 1;
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

function printSummary(daily: DailyStats[], stats: Record<string, number>) {
  console.log(`\n===== BTCD/USDT 兑换池汇总 =====`);
  console.log(`Pair: ${PAIR_ADDRESS}`);
  console.log(`BTCD: ${BTCD_TOKEN_ADDRESS}`);
  console.log(`USDT: ${USDT_TOKEN_ADDRESS}`);
  console.log(`Swap 笔数: ${formatWithCommas(stats.swapCount, 0)}`);
  console.log(`  BTCD 成交量: ${formatWithCommas(stats.btcdVolume, 2)}`);
  console.log(`  USDT 成交量: ${formatWithCommas(stats.usdtVolume, 2)}`);
  console.log(`  BTCD→USDT: ${formatWithCommas(stats.btcdToUsdtCount, 0)} 笔`);
  console.log(`  USDT→BTCD: ${formatWithCommas(stats.usdtToBtcdCount, 0)} 笔`);
  console.log(
    `加流动性: ${formatWithCommas(stats.mintCount, 0)} 笔 | BTCD ${formatWithCommas(stats.mintBtcd, 2)} | USDT ${formatWithCommas(stats.mintUsdt, 2)}`
  );
  console.log(
    `撤流动性: ${formatWithCommas(stats.burnCount, 0)} 笔 | BTCD ${formatWithCommas(stats.burnBtcd, 2)} | USDT ${formatWithCommas(stats.burnUsdt, 2)}`
  );

  const recent = daily.slice(-14);
  if (recent.length === 0) {
    console.log('\n暂无日统计数据');
    return;
  }

  console.log(`\n===== 最近 ${recent.length} 日明细 =====`);
  console.log(
    '日期'.padEnd(12) +
      'Swap'.padStart(6) +
      'BTCDVol'.padStart(14) +
      'USDTVol'.padStart(14) +
      'Mint'.padStart(6) +
      'MintUSDT'.padStart(12) +
      'Burn'.padStart(6) +
      'BurnUSDT'.padStart(12)
  );
  for (const d of recent) {
    console.log(
      d.date.padEnd(12) +
        String(d.swapCount).padStart(6) +
        formatWithCommas(d.btcdVolume, 2).padStart(14) +
        formatWithCommas(d.usdtVolume, 2).padStart(14) +
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

function loadExisting(): Partial<PairStatsFile> & { mints: LiquidityRecord[]; burns: LiquidityRecord[] } | null {
  if (!fs.existsSync(OUTPUT_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8')) as PairStatsFile;
    let mints = data.mints || [];
    let burns = data.burns || [];
    if (fs.existsSync(LIQUIDITY_OUTPUT_FILE)) {
      try {
        const liq = JSON.parse(fs.readFileSync(LIQUIDITY_OUTPUT_FILE, 'utf-8')) as LiquidityFile;
        if (Array.isArray(liq.mints)) mints = liq.mints;
        if (Array.isArray(liq.burns)) burns = liq.burns;
      } catch {
        // 流动性文件损坏时回退主文件内嵌数据
      }
    }
    return { ...data, mints, burns };
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
    lastBlock = existing.lastBlock || 0;
    const { daily, stats } = computeDailyAndTotals(swaps, mints, burns);
    printSummary(daily, stats);
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
  let startBlock = INITIAL_START_BLOCK;

  if (existing && !rescanEvents) {
    existingSwaps = existing.swaps || [];
    existingMints = existing.mints || [];
    existingBurns = existing.burns || [];
    if (typeof existing.lastBlock === 'number' && existing.lastBlock >= INITIAL_START_BLOCK) {
      startBlock = existing.lastBlock + 1;
    }
    console.log(
      `增量模式：已有 Swap ${existingSwaps.length} / Mint ${existingMints.length} / Burn ${existingBurns.length}，从区块 ${startBlock} 继续`
    );
  } else if (rescanEvents) {
    console.log(`--rescan-events：从 start_block ${INITIAL_START_BLOCK} 全量重扫`);
    startBlock = INITIAL_START_BLOCK;
  }

  if (startBlock > currentBlock) {
    console.log(`已同步到最新 (lastBlock=${existing?.lastBlock}, current=${currentBlock})`);
    swaps = existingSwaps;
    mints = existingMints;
    burns = existingBurns;
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
      `分类: Swap ${decoded.swaps.length}, Mint ${decoded.mints.length}, Burn ${decoded.burns.length}, 跳过 ${decoded.skipped}`
    );

    if (rescanEvents) {
      swaps = decoded.swaps;
      mints = decoded.mints;
      burns = decoded.burns;
    } else {
      swaps = mergeByTxHash(existingSwaps, decoded.swaps);
      mints = mergeByTxHash(existingMints, decoded.mints);
      burns = mergeByTxHash(existingBurns, decoded.burns);
    }
    lastBlock = currentBlock;
    console.log(`合并后: Swap ${swaps.length}, Mint ${mints.length}, Burn ${burns.length}`);
  }

  const { daily, stats } = computeDailyAndTotals(swaps, mints, burns);
  printSummary(daily, stats);
  printTopRecentSwaps(swaps, daily);

  const output: PairStatsFile = {
    lastBlock,
    pair: PAIR_ADDRESS,
    btcdToken: BTCD_TOKEN_ADDRESS,
    usdtToken: USDT_TOKEN_ADDRESS,
    stats,
    daily,
    swaps
  };

  const liquidityOutput: LiquidityFile = {
    pair: PAIR_ADDRESS,
    btcdToken: BTCD_TOKEN_ADDRESS,
    usdtToken: USDT_TOKEN_ADDRESS,
    mints,
    burns
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
