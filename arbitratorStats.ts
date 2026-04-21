/**
 * ArbitratorManager：拉取 ArbitratorRegistered 事件，批量 getArbitratorBasicInfo，并查询各守护者地址原生币余额。
 *
 * 使用:
 * npx ts-node arbitratorStats.ts
 * npx ts-node arbitratorStats.ts --network pgp-prod
 * npx ts-node arbitratorStats.ts --skip-timestamp
 * npx ts-node arbitratorStats.ts --rescan-events   # 忽略本地进度，从 start_block 全量扫事件
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

import { formatWithCommas, getBlockTimestamps, getNativeBalancesBatch, timestampToStr } from './util';

function getNetworkFromArgs(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return 'pgp-prod';
}

const network = getNetworkFromArgs();
const networkConfig = require('./network.json') as Record<string, Record<string, unknown>>;
const cfg = networkConfig[network];
if (!cfg) {
  console.error(`未知网络: ${network}`);
  process.exit(1);
}
const ARBITRATOR_MANAGER = cfg.arbitratorManager as string | undefined;
const MULTICALL3_ADDRESS = cfg.multicall3 as string;
const INITIAL_START_BLOCK = cfg.start_block as number;
const BATCH_SIZE = (cfg.batch_size as number) || 50000;
const RPC_URL = cfg.rpc_url as string;

if (!ARBITRATOR_MANAGER) {
  console.error(`network.json 中 [${network}] 未配置 arbitratorManager，无法继续。`);
  process.exit(1);
}

const arbitratorManagerAbi = require('./abi/ArbitratorManager.json').abi;
const multicall3Abi = require('./abi/Multicall3.json').abi;

/** 每轮 Multicall 处理的守护者数量（每人 3 个调用：basicInfo + isActiveArbitrator + getAvailableStake） */
const MULTICALL_BATCH_SIZE = 200;
/** 低余额阈值（原生币 */
const LOW_BALANCE_THRESHOLD_ETH = '0.06';

interface ArbitratorFromEvent {
  arbitrator: string;
  operator: string;
  revenueAddress: string;
  btcAddress: string;
  btcPubKey: string;
  feeRate: string;
  btcFeeRate: string;
  eventDeadline: string;
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
  timestampStr: string;
}

interface ArbitratorRecord extends ArbitratorFromEvent {
  paused: boolean;
  registerTime: number;
  registerTimeStr: string;
  deadline: number;
  deadlineStr: string;
  isActiveArbitrator: boolean;
  /** getAvailableStake，18 位小数可读字符串 */
  availableStake: string;
  availableStakeRaw: string;
  balanceRaw: string;
  balance: string;
}

function parseArgs(): { skipTimestamp: boolean; rescanEvents: boolean } {
  let skipTimestamp = false;
  let rescanEvents = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-timestamp') {
      skipTimestamp = true;
    } else if (args[i] === '--rescan-events') {
      rescanEvents = true;
    }
  }
  return { skipTimestamp, rescanEvents };
}

function recordToFromEvent(r: ArbitratorRecord): ArbitratorFromEvent {
  return {
    arbitrator: r.arbitrator,
    operator: r.operator,
    revenueAddress: r.revenueAddress,
    btcAddress: r.btcAddress,
    btcPubKey: r.btcPubKey,
    feeRate: r.feeRate,
    btcFeeRate: r.btcFeeRate,
    eventDeadline: r.eventDeadline,
    blockNumber: r.blockNumber,
    transactionHash: r.transactionHash,
    timestamp: r.timestamp,
    timestampStr: r.timestampStr
  };
}

/** 合并事件视图：同一地址保留区块号更新的登记记录 */
function mergeEventMaps(
  existing: Map<string, ArbitratorFromEvent>,
  incoming: Map<string, ArbitratorFromEvent>
): Map<string, ArbitratorFromEvent> {
  const out = new Map(existing);
  for (const [k, v] of incoming) {
    const prev = out.get(k);
    if (!prev || v.blockNumber >= prev.blockNumber) {
      out.set(k, v);
    }
  }
  return out;
}

function loadExistingStats(outputFile: string): {
  eventMap: Map<string, ArbitratorFromEvent>;
  lastEventSyncedBlock: number;
} {
  if (!fs.existsSync(outputFile)) {
    return { eventMap: new Map(), lastEventSyncedBlock: INITIAL_START_BLOCK - 1 };
  }
  try {
    const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    const records = (data.records || []) as ArbitratorRecord[];
    const eventMap = new Map<string, ArbitratorFromEvent>();
    for (const r of records) {
      if (r?.arbitrator) {
        eventMap.set(r.arbitrator.toLowerCase(), recordToFromEvent(r));
      }
    }
    let lastEventSyncedBlock = data.eventsSyncedThroughBlock;
    if (typeof lastEventSyncedBlock !== 'number') {
      // 兼容旧文件：曾用 currentBlock 表示写入时的链高度，即事件已扫到该块
      lastEventSyncedBlock =
        typeof data.currentBlock === 'number' ? data.currentBlock : INITIAL_START_BLOCK - 1;
    }
    return { eventMap, lastEventSyncedBlock };
  } catch {
    return { eventMap: new Map(), lastEventSyncedBlock: INITIAL_START_BLOCK - 1 };
  }
}

function parseArbitratorRegisteredLogs(
  logs: any[],
  blockTimestamps: Map<number, number>,
  amIface: any
): Map<string, ArbitratorFromEvent> {
  const byAddr = new Map<string, ArbitratorFromEvent>();

  for (const log of logs) {
    const decoded = amIface.decodeEventLog('ArbitratorRegistered', log.data, log.topics);
    const arbitrator = (decoded.arbitrator as string).toLowerCase();
    const ts = blockTimestamps.get(log.blockNumber) || 0;
    const row: ArbitratorFromEvent = {
      arbitrator: decoded.arbitrator as string,
      operator: decoded.operator as string,
      revenueAddress: decoded.revenueAddress as string,
      btcAddress: decoded.btcAddress as string,
      btcPubKey: ethers.utils.hexlify(decoded.btcPubKey as any),
      feeRate: (decoded.feeRate as any).toString(),
      btcFeeRate: (decoded.btcFeeRate as any).toString(),
      eventDeadline: (decoded.deadline as any).toString(),
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      timestamp: ts,
      timestampStr: ts ? timestampToStr(ts) : ''
    };

    const prev = byAddr.get(arbitrator);
    if (!prev || log.blockNumber >= prev.blockNumber) {
      byAddr.set(arbitrator, row);
    }
  }

  return byAddr;
}

async function fetchArbitratorRegisteredLogs(
  provider: any,
  fromBlock: number,
  toBlock: number,
  amIface: any,
  skipTimestamp: boolean
): Promise<Map<string, ArbitratorFromEvent>> {
  const topic = amIface.getEventTopic('ArbitratorRegistered');
  const allLogs: any[] = [];

  console.log(`\n合约: ${ARBITRATOR_MANAGER}`);
  console.log(`事件: ArbitratorRegistered`);
  console.log(`区块: ${fromBlock} → ${toBlock}`);

  if (fromBlock > toBlock) {
    console.log('(无需拉取新区块内的事件)');
    return new Map();
  }

  for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, toBlock);
    try {
      const logs = await provider.getLogs({
        address: ARBITRATOR_MANAGER,
        topics: [topic],
        fromBlock: start,
        toBlock: end
      });
      if (logs.length > 0) {
        allLogs.push(...logs);
        console.log(`  ${start}-${end}: +${logs.length} (累计 ${allLogs.length})`);
      }
    } catch (error) {
      console.error(`  查询 ${start}-${end} 失败，拆小批次重试…`, error);
      const SMALL = 10000;
      for (let sub = start; sub <= end; sub += SMALL) {
        const subTo = Math.min(sub + SMALL - 1, end);
        try {
          const logs = await provider.getLogs({
            address: ARBITRATOR_MANAGER,
            topics: [topic],
            fromBlock: sub,
            toBlock: subTo
          });
          if (logs.length > 0) {
            allLogs.push(...logs);
            console.log(`    ${sub}-${subTo}: +${logs.length}`);
          }
        } catch (e) {
          console.error(`    ❌ ${sub}-${subTo}`, e);
        }
      }
    }
  }

  allLogs.sort((a, b) => a.blockNumber - b.blockNumber);
  console.log(`\n✅ 本段共 ${allLogs.length} 条 ArbitratorRegistered 日志`);

  let blockTimestamps = new Map<number, number>();
  if (!skipTimestamp && allLogs.length > 0) {
    const blockNums = [...new Set(allLogs.map((l: any) => l.blockNumber))] as number[];
    console.log(`获取 ${blockNums.length} 个区块时间戳…`);
    blockTimestamps = await getBlockTimestamps(blockNums, RPC_URL);
  } else if (skipTimestamp) {
    console.log('已跳过区块时间戳 (--skip-timestamp)');
  }

  const map = parseArbitratorRegisteredLogs(allLogs, blockTimestamps, amIface);
  console.log(`✅ 本段按地址去重后: ${map.size} 个`);
  return map;
}

async function fetchBasicInfoWithMulticall(
  provider: any,
  arbitratorAddrs: string[],
  amIface: any
): Promise<
  Map<
    string,
    {
      paused: boolean;
      registerTime: number;
      deadline: number;
      isActiveArbitrator: boolean;
      availableStake: string;
      availableStakeRaw: string;
    }
  >
> {
  const out = new Map<
    string,
    {
      paused: boolean;
      registerTime: number;
      deadline: number;
      isActiveArbitrator: boolean;
      availableStake: string;
      availableStakeRaw: string;
    }
  >();
  const multicall3 = new ethers.Contract(MULTICALL3_ADDRESS, multicall3Abi, provider);

  for (let i = 0; i < arbitratorAddrs.length; i += MULTICALL_BATCH_SIZE) {
    const batch = arbitratorAddrs.slice(i, i + MULTICALL_BATCH_SIZE);
    const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
    for (const addr of batch) {
      calls.push({
        target: ARBITRATOR_MANAGER,
        allowFailure: true,
        callData: amIface.encodeFunctionData('getArbitratorBasicInfo', [addr])
      });
      calls.push({
        target: ARBITRATOR_MANAGER,
        allowFailure: true,
        callData: amIface.encodeFunctionData('isActiveArbitrator', [addr])
      });
      calls.push({
        target: ARBITRATOR_MANAGER,
        allowFailure: true,
        callData: amIface.encodeFunctionData('getAvailableStake', [addr])
      });
    }

    const results = await multicall3.aggregate3(calls);
    for (let j = 0; j < batch.length; j++) {
      const addrLower = batch[j].toLowerCase();
      const basicRes = results[j * 3];
      const activeRes = results[j * 3 + 1];
      const stakeRes = results[j * 3 + 2];
      if (!basicRes.success) {
        continue;
      }
      let isActiveArbitrator = false;
      if (activeRes.success) {
        try {
          isActiveArbitrator = Boolean(
            amIface.decodeFunctionResult('isActiveArbitrator', activeRes.returnData)[0]
          );
        } catch {
          // 保持 false
        }
      }
      let availableStake = '0';
      let availableStakeRaw = '0';
      if (stakeRes.success) {
        try {
          const stakeBn = amIface.decodeFunctionResult('getAvailableStake', stakeRes.returnData)[0];
          availableStakeRaw = stakeBn.toString();
          availableStake = ethers.utils.formatEther(stakeBn);
        } catch {
          // 保持 0
        }
      }
      try {
        const decoded = amIface.decodeFunctionResult('getArbitratorBasicInfo', basicRes.returnData);
        const t = decoded[0] as any;
        out.set(addrLower, {
          paused: Boolean(t.paused),
          registerTime: t.registerTime.toNumber(),
          deadline: t.deadline.toNumber(),
          isActiveArbitrator,
          availableStake,
          availableStakeRaw
        });
      } catch {
        // 忽略单条解码失败
      }
    }
    console.log(
      `  ${Math.min(i + MULTICALL_BATCH_SIZE, arbitratorAddrs.length)}/${arbitratorAddrs.length} arbitrators updated`
    );
  }

  return out;
}

function mergeRecords(
  eventMap: Map<string, ArbitratorFromEvent>,
  basicMap: Map<
    string,
    {
      paused: boolean;
      registerTime: number;
      deadline: number;
      isActiveArbitrator: boolean;
      availableStake: string;
      availableStakeRaw: string;
    }
  >,
  balanceMap: Map<string, any>
): ArbitratorRecord[] {
  const list: ArbitratorRecord[] = [];

  for (const [addrLower, ev] of eventMap) {
    const basic = basicMap.get(addrLower);
    const bal = balanceMap.get(addrLower) ?? ethers.BigNumber.from(0);
    list.push({
      ...ev,
      paused: basic?.paused ?? false,
      registerTime: basic?.registerTime ?? 0,
      registerTimeStr: timestampToStr(basic?.registerTime ?? 0),
      deadline: basic?.deadline ?? 0,
      deadlineStr: timestampToStr(basic?.deadline ?? 0),
      isActiveArbitrator: basic?.isActiveArbitrator ?? false,
      availableStake: basic?.availableStake ?? '0',
      availableStakeRaw: basic?.availableStakeRaw ?? '0',
      balanceRaw: bal.toString(),
      balance: ethers.utils.formatEther(bal)
    });
  }

  list.sort((a, b) => a.blockNumber - b.blockNumber);
  return list;
}

async function main() {
  const { skipTimestamp, rescanEvents } = parseArgs();
  const startTime = Date.now();
  console.log(`\n===== [网络: ${network}] 守护者统计 =====`);

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const amIface = new ethers.utils.Interface(arbitratorManagerAbi);

  const currentBlock = await provider.getBlockNumber();
  console.log(`当前区块: ${currentBlock}`);

  const outputDir = path.join('data', network);
  const outputFile = path.join(outputDir, 'arbitrator_stats.json');

  let existingEventMap: Map<string, ArbitratorFromEvent>;
  let lastEventSyncedBlock: number;
  if (rescanEvents) {
    console.log('\n已指定 --rescan-events：从 network start_block 全量重扫事件（不合并本地 records 中的历史事件）');
    existingEventMap = new Map();
    lastEventSyncedBlock = INITIAL_START_BLOCK - 1;
  } else {
    const loaded = loadExistingStats(outputFile);
    existingEventMap = loaded.eventMap;
    lastEventSyncedBlock = loaded.lastEventSyncedBlock;
    if (existingEventMap.size > 0) {
      console.log(
        `\n已加载本地 ${existingEventMap.size} 个守护者；事件上次已同步至区块 ${lastEventSyncedBlock}，将从 ${lastEventSyncedBlock + 1} 增量拉取`
      );
    }
  }

  const eventFromBlock = Math.max(INITIAL_START_BLOCK, lastEventSyncedBlock + 1);
  const newEventMap = await fetchArbitratorRegisteredLogs(
    provider,
    eventFromBlock,
    currentBlock,
    amIface,
    skipTimestamp
  );
  const eventMap = mergeEventMaps(existingEventMap, newEventMap);
  console.log(`\n合并后守护者总数: ${eventMap.size}（本地 + 本段增量）`);

  const addrs = [...eventMap.keys()].map(k => eventMap.get(k)!.arbitrator);

  if (addrs.length === 0) {
    console.log('未发现守护者，退出。');
    return;
  }

  console.log(`\n批量更新守护者基础信息 (${addrs.length} 个)…`);
  const startTimeBasic = Date.now();
  const basicMap = await fetchBasicInfoWithMulticall(provider, addrs, amIface);
  console.log(`✅ 成功更新守护者基础信息: ${basicMap.size}/${addrs.length}`);
  const endTimeBasic = Date.now();
  const durationBasic = (endTimeBasic - startTimeBasic) / 1000;
  console.log(`✨守护者基础信息更新耗时: ${durationBasic.toFixed(2)} 秒`);

  console.log(`\n批量查询守护者原生币余额…`);
  const startTimeBalance = Date.now();
  const balanceMap = await getNativeBalancesBatch(addrs, RPC_URL);
  const endTimeBalance = Date.now();
  const durationBalance = (endTimeBalance - startTimeBalance) / 1000;
  console.log(`✨守护者原生币余额查询耗时: ${durationBalance.toFixed(2)} 秒`);
  console.log(`✅ 余额已更新`);


  const records = mergeRecords(eventMap, basicMap, balanceMap);
  const totalBalance = records.reduce(
    (s, r) => s.add(ethers.BigNumber.from(r.balanceRaw)),
    ethers.BigNumber.from(0)
  );
  const totalStakeBalance = records.reduce(
    (s, r) => s.add(ethers.BigNumber.from(r.availableStakeRaw)),
    ethers.BigNumber.from(0)
  );

  const lowBalanceThresholdWei = ethers.utils.parseEther(LOW_BALANCE_THRESHOLD_ETH);
  const lowBalanceRecords = records
    .filter(r => ethers.BigNumber.from(r.balanceRaw).lt(lowBalanceThresholdWei))
    .sort((a, b) => {
      const ba = ethers.BigNumber.from(a.balanceRaw);
      const bb = ethers.BigNumber.from(b.balanceRaw);
      if (ba.lt(bb)) return -1;
      if (ba.gt(bb)) return 1;
      return 0;
    });

  const activeArbitrators = records.filter(r => r.isActiveArbitrator);
  const inactiveArbitrators = records.filter(r => !r.isActiveArbitrator);

  console.log(`\n===== 守护者统计 =====`);
  console.log(`守护者总数: ${formatWithCommas(records.length, 0)}`);
  console.log(`活跃守护者: ${formatWithCommas(activeArbitrators.length, 0)}`);
  console.log(`非活跃守护者: ${formatWithCommas(inactiveArbitrators.length, 0)}`);
  console.log(`低余额守护者: ${formatWithCommas(lowBalanceRecords.length, 0)}`);
  console.log(`守护者 PGA 余额合计: ${formatWithCommas(ethers.utils.formatEther(totalBalance), 4)}`);
  console.log(`守护者质押的 ELA 余额合计: ${formatWithCommas(ethers.utils.formatEther(totalStakeBalance), 4)}`);

  if (lowBalanceRecords.length > 0) {
    console.log(`\n===== 低余额守护者(余额 < ${LOW_BALANCE_THRESHOLD_ETH} 按余额升序）=====`);
    lowBalanceRecords.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.arbitrator}  余额: ${r.balance}`);
    });
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const lowBalanceFile = path.join(outputDir, 'arbitrator_low_balance.json');
  const payloadBase = {
    network,
    arbitratorManager: ARBITRATOR_MANAGER,
    currentBlock,
    eventsSyncedThroughBlock: currentBlock,
    fetchedAt: new Date().toISOString()
  };

  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        ...payloadBase,
        totalArbitrators: records.length,
        activeArbitrators: activeArbitrators.length,
        inactiveArbitrators: inactiveArbitrators.length,
        totalNativeBalance: ethers.utils.formatEther(totalBalance),
        totalNativeBalanceRaw: totalBalance.toString(),
        totalStakeBalance: ethers.utils.formatEther(totalStakeBalance),
        totalStakeBalanceRaw: totalStakeBalance.toString(),
        records
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    lowBalanceFile,
    JSON.stringify(
      {
        ...payloadBase,
        lowBalanceThresholdNative: LOW_BALANCE_THRESHOLD_ETH,
        count: lowBalanceRecords.length,
        records: lowBalanceRecords
      },
      null,
      2
    )
  );

  console.log(`\n已写入: ${outputFile}`);
  console.log(
    `已写入 (余额 < ${LOW_BALANCE_THRESHOLD_ETH}): ${lowBalanceFile} (${formatWithCommas(lowBalanceRecords.length, 0)} 条)`
  );

  // 显示脚本执行总时间
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`\n===== 脚本执行完成 =====`);
  console.log(`✨总耗时: ${duration.toFixed(2)} 秒`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
