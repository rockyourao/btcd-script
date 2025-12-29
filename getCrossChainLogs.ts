/**
 * 通过 getLogs 获取跨链交易（从最新区块往前搜索）
 *
 * 使用方法:
 * npx ts-node getCrossChainLogs.ts --to <address>                      # 获取最新 20 条
 * npx ts-node getCrossChainLogs.ts --to <address> --limit 50           # 获取最新 50 条
 * npx ts-node getCrossChainLogs.ts --to <address> --before 3000000     # 从区块 3000000 往前找
 * npx ts-node getCrossChainLogs.ts --to <address> --all                # 获取所有（从头扫描）
 * npx ts-node getCrossChainLogs.ts --from <address>                    # 按发送者过滤
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from 'ethers';
import { getBlockTimestamps, topicToAddress, topicToAmount } from './util';
const fs = require('fs');

const RPC_URL = 'https://api.elastos.cc/eco';
const BATCH_SIZE = 50000;

// 跨链事件签名 (从分析交易得到)
// 事件: CrossChain(address sender, bytes32 txId, address targetAddress, uint256 amount)
const CROSS_CHAIN_TOPIC = '0x09f15c376272c265d7fcb47bf57d8f84a928195e6ea156d12f5a3cd05b8fed5a';

// 零地址（跨链事件来自这个地址）
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// 默认限制数量
const DEFAULT_LIMIT = 20;

interface CrossChainRecord {
  sender: string;        // 发送者地址 (topics[1])
  txId: string;          // 跨链交易 ID (topics[2])
  targetAddress: string; // 目标地址 (topics[3])
  amount: string;        // 金额 (topics[4])
  amountRaw: string;
  blockNumber: number;
  timestamp: number;
  timestampStr: string;
  transactionHash: string;
}

interface QueryOptions {
  filterFromAddress?: string;
  filterToAddress?: string;
  limit?: number;
  beforeBlock?: number;
  fetchAll?: boolean;
}

/**
 * 构建 topics 过滤数组
 */
function buildTopics(filterFromAddress?: string, filterToAddress?: string): (string | null)[] {
  const topics: (string | null)[] = [CROSS_CHAIN_TOPIC];

  if (filterFromAddress) {
    topics.push('0x000000000000000000000000' + filterFromAddress.slice(2).toLowerCase());
  } else {
    topics.push(null);
  }

  topics.push(null); // txId 不过滤

  if (filterToAddress) {
    topics.push('0x000000000000000000000000' + filterToAddress.slice(2).toLowerCase());
  }

  return topics;
}

/**
 * 解析日志为记录
 */
function parseLogsToRecords(logs: any[], blockTimestamps: Map<number, number>): CrossChainRecord[] {
  return logs.map((log: any) => {
    const timestamp = blockTimestamps.get(log.blockNumber) || 0;
    const timestampStr = timestamp ? new Date(timestamp * 1000).toISOString() : '';

    const sender = topicToAddress(log.topics[1]);
    const txId = log.topics[2];
    const targetAddress = topicToAddress(log.topics[3]);
    const amountBN = topicToAmount(log.topics[4]);

    return {
      sender,
      txId,
      targetAddress,
      amount: (ethers as any).utils.formatEther(amountBN),
      amountRaw: amountBN.toString(),
      blockNumber: log.blockNumber,
      timestamp,
      timestampStr,
      transactionHash: log.transactionHash
    };
  });
}

/**
 * 从最新区块往前搜索跨链交易
 */
async function getCrossChainLogsReverse(
  provider: any,
  currentBlock: number,
  options: QueryOptions
): Promise<{ records: CrossChainRecord[]; nextBeforeBlock: number | null }> {
  const { filterFromAddress, filterToAddress, limit = DEFAULT_LIMIT, beforeBlock, fetchAll = false } = options;

  const endBlock = beforeBlock ? beforeBlock - 1 : currentBlock;
  const startBlock = 1;
  const targetCount = fetchAll ? Infinity : limit;

  console.log(`从区块 ${endBlock} 往前搜索...`);
  if (!fetchAll) {
    console.log(`目标: 找到 ${targetCount} 条记录后停止`);
  }

  const allLogs: any[] = [];
  const topics = buildTopics(filterFromAddress, filterToAddress);

  // 从最新区块往前搜索
  let searchedBlocks = 0;
  for (let toBlock = endBlock; toBlock >= startBlock; toBlock -= BATCH_SIZE) {
    const fromBlock = Math.max(toBlock - BATCH_SIZE + 1, startBlock);

    try {
      const logs = await provider.getLogs({
        address: ZERO_ADDRESS,
        topics: topics,
        fromBlock,
        toBlock
      });

      if (logs.length > 0) {
        // 按区块号降序排序（最新的在前）
        logs.sort((a: any, b: any) => b.blockNumber - a.blockNumber);
        allLogs.push(...logs);
        console.log(`区块 ${fromBlock} - ${toBlock}: 找到 ${logs.length} 条 (累计: ${allLogs.length})`);
        console.log('logs', logs);
      }

      searchedBlocks += BATCH_SIZE;

      // 检查是否已找到足够数量
      if (!fetchAll && allLogs.length >= targetCount) {
        console.log(`已找到 ${allLogs.length} 条记录，达到目标数量，停止搜索`);
        break;
      }
    } catch (error) {
      console.error(`查询区块 ${fromBlock} - ${toBlock} 失败:`, error);
      // 尝试更小的批次
      const SMALLER_BATCH = 10000;
      for (let subTo = toBlock; subTo >= fromBlock; subTo -= SMALLER_BATCH) {
        const subFrom = Math.max(subTo - SMALLER_BATCH + 1, fromBlock);
        try {
          const logs = await provider.getLogs({
            address: ZERO_ADDRESS,
            topics: topics,
            fromBlock: subFrom,
            toBlock: subTo
          });
          if (logs.length > 0) {
            logs.sort((a: any, b: any) => b.blockNumber - a.blockNumber);
            allLogs.push(...logs);
            console.log(`区块 ${subFrom} - ${subTo}: 找到 ${logs.length} 条 (累计: ${allLogs.length})`);
            console.log('logs', logs);
          }

          if (!fetchAll && allLogs.length >= targetCount) {
            break;
          }
        } catch (subError) {
          console.error(`查询区块 ${subFrom} - ${subTo} 失败:`, subError);
        }
      }

      if (!fetchAll && allLogs.length >= targetCount) {
        break;
      }
    }
  }

  console.log(`\n总共获取到 ${allLogs.length} 条跨链事件日志`);

  if (allLogs.length === 0) {
    return { records: [], nextBeforeBlock: null };
  }

  // 按区块号降序排序，然后取需要的数量
  allLogs.sort((a: any, b: any) => b.blockNumber - a.blockNumber);
  const logsToProcess = fetchAll ? allLogs : allLogs.slice(0, limit);

  // 获取区块时间戳
  const uniqueBlockNumbers = [...new Set(logsToProcess.map((log: any) => log.blockNumber))] as number[];
  console.log(`需要获取 ${uniqueBlockNumbers.length} 个区块的时间戳...`);

  const blockTimestamps = await getBlockTimestamps(uniqueBlockNumbers, RPC_URL);
  const records = parseLogsToRecords(logsToProcess, blockTimestamps);

  // 计算下一页的 beforeBlock（最后一条记录的区块号）
  const nextBeforeBlock = records.length > 0 ? records[records.length - 1].blockNumber : null;

  return { records, nextBeforeBlock };
}

async function main() {
  const args = process.argv.slice(2);

  let filterFromAddress: string | undefined;
  let filterToAddress: string | undefined;
  let limit: number = DEFAULT_LIMIT;
  let beforeBlock: number | undefined;
  let fetchAll = false;

  // 解析参数
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to' && args[i + 1]) {
      filterToAddress = args[i + 1];
      i++;
    } else if (args[i] === '--from' && args[i + 1]) {
      filterFromAddress = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--before' && args[i + 1]) {
      beforeBlock = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--all') {
      fetchAll = true;
    } else if (args[i].startsWith('0x')) {
      filterFromAddress = args[i];
    }
  }

  console.log('\n===== 获取跨链交易 =====');
  console.log(`事件签名: ${CROSS_CHAIN_TOPIC}`);
  if (filterFromAddress) {
    console.log(`过滤发送者: ${filterFromAddress}`);
  }
  if (filterToAddress) {
    console.log(`过滤目标地址: ${filterToAddress}`);
  }
  if (!fetchAll) {
    console.log(`限制数量: ${limit}`);
  } else {
    console.log(`模式: 获取全部`);
  }
  if (beforeBlock) {
    console.log(`从区块 ${beforeBlock} 之前开始`);
  }

  const provider = new (ethers as any).providers.JsonRpcProvider(RPC_URL);
  const currentBlock = await provider.getBlockNumber();
  console.log(`当前区块高度: ${currentBlock}`);

  const { records, nextBeforeBlock } = await getCrossChainLogsReverse(provider, currentBlock, {
    filterFromAddress,
    filterToAddress,
    limit,
    beforeBlock,
    fetchAll
  });

  console.log(`\n===== 跨链交易统计 =====`);
  console.log(`返回记录数: ${records.length}`);

  if (records.length > 0) {
    // 计算总金额
    let totalAmount = (ethers as any).BigNumber.from(0);
    for (const r of records) {
      totalAmount = totalAmount.add((ethers as any).BigNumber.from(r.amountRaw));
    }
    console.log(`总跨链金额: ${(ethers as any).utils.formatEther(totalAmount)} ELA`);

    // 统计唯一发送者和接收者
    const uniqueSenders = new Set(records.map(r => r.sender));
    const uniqueTargets = new Set(records.map(r => r.targetAddress));
    console.log(`唯一发送者数: ${uniqueSenders.size}`);
    console.log(`唯一接收者数: ${uniqueTargets.size}`);

    // 显示记录
    console.log(`\n===== 跨链记录 (按时间倒序) =====`);
    for (const r of records.slice(0, 10)) {
      console.log(`\n${r.timestampStr} (区块 ${r.blockNumber})`);
      console.log(`  发送者: ${r.sender}`);
      console.log(`  目标地址: ${r.targetAddress}`);
      console.log(`  金额: ${r.amount} ELA`);
      console.log(`  交易: https://eco.elastos.io/tx/${r.transactionHash}`);
    }

    if (records.length > 10) {
      console.log(`\n... 还有 ${records.length - 10} 条记录`);
    }

    // 分页提示
    if (nextBeforeBlock && !fetchAll) {
      console.log(`\n===== 分页信息 =====`);
      console.log(`下一页命令:`);
      const baseCmd = `npx ts-node getCrossChainLogs.ts`;
      const filterArgs = filterToAddress ? `--to ${filterToAddress}` : filterFromAddress ? `--from ${filterFromAddress}` : '';
      console.log(`  ${baseCmd} ${filterArgs} --limit ${limit} --before ${nextBeforeBlock}`);
    }

    // 保存到文件
    const outputFile = filterFromAddress
      ? `data/crosschain_from_${filterFromAddress.slice(0, 10)}.json`
      : filterToAddress
        ? `data/crosschain_to_${filterToAddress.slice(0, 10)}.json`
        : 'data/crosschain_all.json';

    fs.writeFileSync(outputFile, JSON.stringify({
      totalRecords: records.length,
      totalAmount: (ethers as any).utils.formatEther(totalAmount),
      currentBlock,
      nextBeforeBlock,
      records
    }, null, 2));
    console.log(`\n记录已保存到 ${outputFile}`);
  }
}

main().catch(console.error);
