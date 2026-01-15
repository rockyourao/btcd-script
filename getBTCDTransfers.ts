/**
 * 获取 BTCD(ERC20 Token) 的所有 Transfer 事件
 *
 * 使用方法:
 * npx ts-node getBTCDTransfers.ts
 * npx ts-node getBTCDTransfers.ts --network pgp-prod  # 指定网络
 * 转换默认的 btcd_transfers.json
 * npx ts-node getBTCDTransfers.ts --to-csv

 * 或指定文件名
 * npx ts-node getBTCDTransfers.ts --to-csv btcd_transfers_1212.json
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from 'ethers';
const fs = require('fs');

import {
  TIMESTAMP_BATCH_SIZE
} from './config';
import { formatTimestampDisplay, formatWithCommas, getUnitStartTimestamp } from './util';

// 从命令行参数解析 network
function getNetworkFromArgs(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return 'pgp-prod'; // 默认值
}

const network = getNetworkFromArgs();

// 从 network.json 加载配置
const networkConfig = require('./network.json');
const INITIAL_START_BLOCK = networkConfig[network].start_block;
const BATCH_SIZE = networkConfig[network].batch_size;
const RPC_URL = networkConfig[network].rpc_url;
const TOKEN_ADDRESS = networkConfig[network].stable_coin_contractaddress.toLowerCase();
const TOKEN_DECIMALS = 18;
const ISSUER_ADDRESS = networkConfig[network].issuer_contractaddress.toLowerCase();


// 输出文件
export const OUTPUT_FILE = `data/${network}/btcd_transfers.json`;

// Transfer 事件 ABI
const TRANSFER_EVENT_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

// 零地址（用于在 RPC 层面过滤铸造和销毁）
const ZERO_ADDRESS_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

interface TransferRecord {
  from: string;
  to: string;
  value: string;
  valueRaw: string;
  blockNumber: number;
  timestamp: number;
  timestampStr: string;
  transactionHash: string;
}

// JSON 文件保存格式（包含元数据）
interface TransferData {
  lastBlock: number;
  stats: any;
  transfers: TransferRecord[];
  usdtTransfers: TransferRecord[];
}

type BtcdStats = { mintedBTCD: number; burnedBTCD: number; mintedBTCDByOrder: number; burnedBTCDByOrder: number; mintedBTCDByUSDT: number; burnedBTCDByUSDT: number; netValue: number, netValueByOrder: number };

async function getAllTransfers(startBlock: number): Promise<{ transfers: TransferRecord[]; lastBlock: number }> {
  console.log('正在连接到 RPC...');
  const provider = new (ethers as any).providers.JsonRpcProvider(RPC_URL);

  // 获取当前区块高度
  const currentBlock = await provider.getBlockNumber();
  console.log(`当前区块高度: ${currentBlock}`);
  console.log(`从区块 ${startBlock} 开始查询...`);

  // ERC20 Transfer 事件签名
  const transferTopic = (ethers as any).utils.id('Transfer(address,address,uint256)');

  console.log(`正在查询 Token: ${TOKEN_ADDRESS}`);
  console.log('正在获取铸造/销毁事件（在 RPC 层面过滤，更快）...');

  // 分批查询避免 RPC 限制
  const allLogs: any[] = [];

  // 定义两种查询：铸造和销毁
  // 铸造: from = 零地址
  // 销毁: to = 零地址
  const queries = [
    { name: '铸造', topics: [transferTopic, ZERO_ADDRESS_TOPIC, null] },
    { name: '销毁', topics: [transferTopic, null, ZERO_ADDRESS_TOPIC] }
  ];

  for (const query of queries) {
    console.log(`\n正在查询${query.name}事件...`);

    for (let fromBlock = startBlock; fromBlock <= currentBlock; fromBlock += BATCH_SIZE) {
      const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, currentBlock);

      try {
        const logs = await provider.getLogs({
          address: TOKEN_ADDRESS,
          topics: query.topics,
          fromBlock,
          toBlock
        });

        allLogs.push(...logs);

        if (logs.length > 0) {
          console.log(`区块 ${fromBlock} - ${toBlock}: 找到 ${logs.length} 条${query.name}记录`);
        }
      } catch (error) {
        console.error(`查询区块 ${fromBlock} - ${toBlock} 失败:`, error);
        // 如果失败，尝试更小的批次
        const SMALLER_BATCH = 10000;
        // for (let subFrom = fromBlock; subFrom <= toBlock; subFrom += SMALLER_BATCH) {
          const subFrom = fromBlock;
          const subTo = Math.min(fromBlock + SMALLER_BATCH - 1, currentBlock);
          try {
            const logs = await provider.getLogs({
              address: TOKEN_ADDRESS,
              topics: query.topics,
              fromBlock: subFrom,
              toBlock: subTo
            });
            allLogs.push(...logs);
            if (logs.length > 0) {
              console.log(`区块 ${subFrom} - ${subTo}: 找到 ${logs.length} 条${query.name}记录`);
            }
          } catch (subError) {
            console.error(`查询区块 ${subFrom} - ${subTo} 失败:`, subError);
          }
        // }
      }
    }
  }

  console.log(`\n总共获取到 ${allLogs.length} 条铸造/销毁事件日志`);

  // 收集所有唯一的区块号
  const uniqueBlockNumbers = [...new Set(allLogs.map((log: any) => log.blockNumber))] as number[];
  console.log(`需要获取 ${uniqueBlockNumbers.length} 个区块的时间戳...`);

  // 使用 JSON-RPC Batch 请求批量获取区块时间戳（更快）
  const blockTimestamps: Map<number, number> = new Map();

  for (let i = 0; i < uniqueBlockNumbers.length; i += TIMESTAMP_BATCH_SIZE) {
    const batch = uniqueBlockNumbers.slice(i, i + TIMESTAMP_BATCH_SIZE);

    try {
      // 构建 JSON-RPC batch 请求
      const batchRequest = batch.map((blockNum: number, idx: number) => ({
        jsonrpc: '2.0',
        id: idx,
        method: 'eth_getBlockByNumber',
        params: ['0x' + blockNum.toString(16), false] // false = 不包含完整交易
      }));

      // 发送 batch 请求
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchRequest)
      });

      const results = await response.json() as any[];

      // 解析结果
      for (const result of results) {
        if (result.result && result.result.timestamp) {
          const blockNum = parseInt(result.result.number, 16);
          const timestamp = parseInt(result.result.timestamp, 16);
          blockTimestamps.set(blockNum, timestamp);
        }
      }

      console.log(`已获取 ${Math.min(i + TIMESTAMP_BATCH_SIZE, uniqueBlockNumbers.length)}/${uniqueBlockNumbers.length} 个区块时间戳`);
    } catch (error) {
      console.error(`Batch 获取区块时间戳失败 (${i} - ${i + batch.length}):`, error);
      // 回退到逐个获取
      for (const blockNum of batch) {
        try {
          const block = await provider.getBlock(blockNum);
          if (block) {
            blockTimestamps.set(block.number, block.timestamp);
          }
        } catch (e) {
          console.error(`获取区块 ${blockNum} 时间戳失败:`, e);
        }
      }
    }
  }

  console.log('正在解析日志...');

  // 解析日志
  const iface = new (ethers as any).utils.Interface(TRANSFER_EVENT_ABI);

  const transfers: TransferRecord[] = allLogs.map((log: any) => {
    const parsed = iface.parseLog(log);
    const timestamp = blockTimestamps.get(log.blockNumber) || 0;
    const timestampStr = timestamp ? new Date(timestamp * 1000).toISOString() : '';

    return {
      from: parsed.args.from,
      to: parsed.args.to,
      value: (ethers as any).utils.formatUnits(parsed.args.value, TOKEN_DECIMALS),
      valueRaw: parsed.args.value.toString(),
      blockNumber: log.blockNumber,
      timestamp,
      timestampStr,
      transactionHash: log.transactionHash
    };
  });

  return { transfers, lastBlock: currentBlock };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}分${seconds.toString().padStart(2, '0')}秒`;
  }
  return `${seconds}秒`;
}

async function main() {
  const startTime = Date.now();

  try {
    // 读取现有数据（如果存在）
    let existingTransfers: TransferRecord[] = [];
    let startBlock = INITIAL_START_BLOCK;

    if (fs.existsSync(OUTPUT_FILE)) {
      console.log(`发现现有文件 ${OUTPUT_FILE}，读取中...`);
      const existingData: TransferData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      existingTransfers = existingData.transfers || [];
      // 从上次保存的区块 +1 开始
      startBlock = (existingData.lastBlock || INITIAL_START_BLOCK) + 1;
      console.log(`已有 ${existingTransfers.length} 条记录，将从区块 ${startBlock} 继续获取`);
    }

    // 获取新数据
    const { transfers: newTransfers, lastBlock } = await getAllTransfers(startBlock);

    // 合并数据（去重，基于 transactionHash）
    const existingHashes = new Set(existingTransfers.map(t => t.transactionHash));
    const uniqueNewTransfers = newTransfers.filter(t => !existingHashes.has(t.transactionHash));

    const transfers = [...existingTransfers, ...uniqueNewTransfers];
    // 按区块号排序
    transfers.sort((a, b) => b.blockNumber - a.blockNumber);

    console.log(`新增 ${uniqueNewTransfers.length} 条记录`);

    console.log(`\n===== 所有 BTCD 铸造/销毁 统计 =====`);
    console.log(`总记录数: ${transfers.length}`);

    const dailyBtcdStats: Map<number, BtcdStats> = new Map();
    const weeklyBtcdStats: Map<number, BtcdStats> = new Map();
    const monthlyBtcdStats: Map<number, BtcdStats> = new Map();

    if (transfers.length > 0) {
      // 计算净铸造量（铸造 - 销毁）
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
      let totalMinted = (ethers as any).BigNumber.from(0);
      let totalBurned = (ethers as any).BigNumber.from(0);

      // 统计非 Issuer 的铸造/销毁（即通过 USDT 的铸造和销毁）
      let mintedByUsdt = (ethers as any).BigNumber.from(0);
      let burnedByUsdt = (ethers as any).BigNumber.from(0);

      for (const t of transfers) {
        const dayTimestamp = getUnitStartTimestamp(t.timestamp, 'day');
        const weekTimestamp = getUnitStartTimestamp(t.timestamp, 'week');
        const monthTimestamp = getUnitStartTimestamp(t.timestamp, 'month');
        const existingDailyBtcd = dailyBtcdStats.get(dayTimestamp) || { mintedBTCD: 0, burnedBTCD: 0, mintedBTCDByOrder: 0, burnedBTCDByOrder: 0, mintedBTCDByUSDT: 0, burnedBTCDByUSDT: 0, netValue: 0, netValueByOrder: 0 };
        const existingWeeklyBtcd = weeklyBtcdStats.get(weekTimestamp) || { mintedBTCD: 0, burnedBTCD: 0, mintedBTCDByOrder: 0, burnedBTCDByOrder: 0, mintedBTCDByUSDT: 0, burnedBTCDByUSDT: 0, netValue: 0, netValueByOrder: 0 };
        const existingMonthlyBtcd = monthlyBtcdStats.get(monthTimestamp) || { mintedBTCD: 0, burnedBTCD: 0, mintedBTCDByOrder: 0, burnedBTCDByOrder: 0, mintedBTCDByUSDT: 0, burnedBTCDByUSDT: 0, netValue: 0, netValueByOrder: 0};

        let actionByUSDT = t.from.toLowerCase() !== ISSUER_ADDRESS && t.to.toLowerCase() !== ISSUER_ADDRESS;

        const value = (ethers as any).BigNumber.from(t.valueRaw);
        if (t.from === ZERO_ADDRESS) {
          // 铸造
          totalMinted = totalMinted.add(value);

          existingDailyBtcd.mintedBTCD += parseFloat(t.value);
          existingWeeklyBtcd.mintedBTCD += parseFloat(t.value);
          existingMonthlyBtcd.mintedBTCD += parseFloat(t.value);

          existingDailyBtcd.netValue += parseFloat(t.value);
          existingWeeklyBtcd.netValue += parseFloat(t.value);
          existingMonthlyBtcd.netValue += parseFloat(t.value);

          if (actionByUSDT) {
            // 通过 USDT 铸造
            mintedByUsdt = mintedByUsdt.add(value);

            existingDailyBtcd.mintedBTCDByUSDT += parseFloat(t.value);
            existingWeeklyBtcd.mintedBTCDByUSDT += parseFloat(t.value);
            existingMonthlyBtcd.mintedBTCDByUSDT += parseFloat(t.value);
          } else {
            // 通过 Order 铸造
            existingDailyBtcd.mintedBTCDByOrder += parseFloat(t.value);
            existingWeeklyBtcd.mintedBTCDByOrder += parseFloat(t.value);
            existingMonthlyBtcd.mintedBTCDByOrder += parseFloat(t.value);

            existingDailyBtcd.netValueByOrder += parseFloat(t.value);
            existingWeeklyBtcd.netValueByOrder += parseFloat(t.value);
            existingMonthlyBtcd.netValueByOrder += parseFloat(t.value);
          }
        } else if (t.to === ZERO_ADDRESS) {
          // 销毁
          totalBurned = totalBurned.add(value);

          existingDailyBtcd.burnedBTCD += parseFloat(t.value);
          existingWeeklyBtcd.burnedBTCD += parseFloat(t.value);
          existingMonthlyBtcd.burnedBTCD += parseFloat(t.value);

          existingDailyBtcd.netValue -= parseFloat(t.value);
          existingWeeklyBtcd.netValue -= parseFloat(t.value);
          existingMonthlyBtcd.netValue -= parseFloat(t.value);

          if (actionByUSDT) {
            // 通过 USDT 销毁
            burnedByUsdt = burnedByUsdt.add(value);

            existingDailyBtcd.burnedBTCDByUSDT += parseFloat(t.value);
            existingWeeklyBtcd.burnedBTCDByUSDT += parseFloat(t.value);
            existingMonthlyBtcd.burnedBTCDByUSDT += parseFloat(t.value);
          } else {
            // 通过 Order 销毁
            existingDailyBtcd.burnedBTCDByOrder += parseFloat(t.value);
            existingWeeklyBtcd.burnedBTCDByOrder += parseFloat(t.value);
            existingMonthlyBtcd.burnedBTCDByOrder += parseFloat(t.value);

            existingDailyBtcd.netValueByOrder -= parseFloat(t.value);
            existingWeeklyBtcd.netValueByOrder -= parseFloat(t.value);
            existingMonthlyBtcd.netValueByOrder -= parseFloat(t.value);
          }
        }

        dailyBtcdStats.set(dayTimestamp, existingDailyBtcd);
        weeklyBtcdStats.set(weekTimestamp, existingWeeklyBtcd);
        monthlyBtcdStats.set(monthTimestamp, existingMonthlyBtcd);
      }
      const netValue = totalMinted.sub(totalBurned);
      const netValueByUSDT = mintedByUsdt.sub(burnedByUsdt);

      // 统计非 Issuer 的铸造/销毁（即通过 USDT 的铸造和销毁）
      const usdtTransfers = transfers.filter(
        t => t.from.toLowerCase() !== ISSUER_ADDRESS &&
             t.to.toLowerCase() !== ISSUER_ADDRESS
      );
      usdtTransfers.sort((a, b) => b.blockNumber - a.blockNumber);

      const stats = {
        totalBTCDMinted: (ethers as any).utils.formatUnits(totalMinted, TOKEN_DECIMALS),
        totalBTCDBurned: (ethers as any).utils.formatUnits(totalBurned, TOKEN_DECIMALS),
        totalBTCDNetValue: (ethers as any).utils.formatUnits(netValue, TOKEN_DECIMALS),
        usdtBTCDMinted: (ethers as any).utils.formatUnits(mintedByUsdt, TOKEN_DECIMALS),
        usdtBTCDBurned: (ethers as any).utils.formatUnits(burnedByUsdt, TOKEN_DECIMALS),
        usdtBTCDNetValue: (ethers as any).utils.formatUnits(netValueByUSDT, TOKEN_DECIMALS),
        usdtBTCDCount: usdtTransfers.length,
        totalBTCDCount: transfers.length,
      };

      console.log(`总铸造量: ${formatWithCommas(stats.totalBTCDMinted, 2)} BTCD`);
      console.log(`总销毁量: ${formatWithCommas(stats.totalBTCDBurned, 2)} BTCD`);
      console.log(`净流通量: ${formatWithCommas(stats.totalBTCDNetValue, 2)} BTCD`);
      console.log(`\n===== 通过USDT 铸造/销毁 的BTCD统计 =====`);
      console.log(`USDT铸造量: ${formatWithCommas(stats.usdtBTCDMinted, 2)} BTCD`);
      console.log(`USDT销毁量: ${formatWithCommas(stats.usdtBTCDBurned, 2)} BTCD`);
      console.log(`USDT净流通: ${formatWithCommas(stats.usdtBTCDNetValue, 2)} BTCD`);
      console.log(`USDT记录数: ${formatWithCommas(stats.usdtBTCDCount, 0)}`);

      // 转换为数组并按日期排序（用于趋势图）
      const dailyBtcdArray = Array.from(dailyBtcdStats.entries())
      .map(([timestamp, data]) => ({
        date: formatTimestampDisplay(timestamp, 'day'),
        timestamp,
        mintedBTCD: data.mintedBTCD,
        burnedBTCD: data.burnedBTCD,
        mintedBTCDByOrder: data.mintedBTCDByOrder,
        burnedBTCDByOrder: data.burnedBTCDByOrder,
        mintedBTCDByUSDT: data.mintedBTCDByUSDT,
        burnedBTCDByUSDT: data.burnedBTCDByUSDT,
        netValue: data.netValue,
        netValueByOrder: data.netValueByOrder,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

      // 打印每日借出统计
      console.log(`\n===== 每日 BTCD 流通量统计 (共 ${dailyBtcdArray.length} 天) =====`);
      dailyBtcdArray.slice(-7).reverse().forEach(day => {
        console.log(`  ${day.date}: 铸造ByOrder=${formatWithCommas(day.mintedBTCDByOrder, 4)}, 销毁ByOrder=${formatWithCommas(day.burnedBTCDByOrder, 4)}, 净流通ByOrder=${formatWithCommas(day.netValueByOrder, 4)}`);
      });

      // 转换为数组并按日期排序（用于趋势图）
      const weeklyBtcdArray = Array.from(weeklyBtcdStats.entries())
      .map(([timestamp, data]) => ({
        date: formatTimestampDisplay(timestamp, 'week'),
        timestamp,
        mintedBTCD: data.mintedBTCD,
        burnedBTCD: data.burnedBTCD,
        mintedBTCDByOrder: data.mintedBTCDByOrder,
        burnedBTCDByOrder: data.burnedBTCDByOrder,
        mintedBTCDByUSDT: data.mintedBTCDByUSDT,
        burnedBTCDByUSDT: data.burnedBTCDByUSDT,
        netValue: data.netValue,
        netValueByOrder: data.netValueByOrder,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

      // 打印每周 BTCD 流通量统计
      console.log(`\n===== 每周 BTCD 流通量统计 (共 ${weeklyBtcdArray.length} 周) =====`);
      weeklyBtcdArray.slice(-7).reverse().forEach(week => {
        console.log(`  ${week.date}: 铸造ByOrder=${formatWithCommas(week.mintedBTCDByOrder, 4)}, 销毁ByOrder=${formatWithCommas(week.burnedBTCDByOrder, 4)}, 净流通ByOrder=${formatWithCommas(week.netValueByOrder, 4)}`);
      });

      // 转换为数组并按日期排序（用于趋势图）
      const monthlyBtcdArray = Array.from(monthlyBtcdStats.entries())
      .map(([timestamp, data]) => ({
        date: formatTimestampDisplay(timestamp, 'month'),
        timestamp,
        mintedBTCD: data.mintedBTCD,
        burnedBTCD: data.burnedBTCD,
        mintedBTCDByOrder: data.mintedBTCDByOrder,
        burnedBTCDByOrder: data.burnedBTCDByOrder,
        mintedBTCDByUSDT: data.mintedBTCDByUSDT,
        burnedBTCDByUSDT: data.burnedBTCDByUSDT,
        netValue: data.netValue,
        netValueByOrder: data.netValueByOrder,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

      // 打印每月 BTCD 流通量统计
      console.log(`\n===== 每月 BTCD 流通量统计 (共 ${monthlyBtcdArray.length} 月) =====`);
      monthlyBtcdArray.slice(-7).reverse().forEach(month => {
        console.log(`  ${month.date}: 铸造ByOrder=${formatWithCommas(month.mintedBTCDByOrder, 4)}, 销毁ByOrder=${formatWithCommas(month.burnedBTCDByOrder, 4)}, 净流通ByOrder=${formatWithCommas(month.netValueByOrder, 4)}`);
      });


      // 显示前5条记录
      // console.log(`\n===== 最新 5 条 Transfer 记录 =====`);
      // const latest10 = transfers.slice(-5).reverse();
      // for (const t of latest10) {
      //   console.log(`${t.timestampStr} 区块 ${t.blockNumber}: ${t.from.slice(0, 10)}... -> ${t.to.slice(0, 10)}... | ${t.value} BTCD`);
      //   console.log(`  交易哈希: ${t.transactionHash}`);
      // }

      // 保存到 JSON 文件（包含 lastBlock 元数据）
      const outputData: TransferData = {
        lastBlock,
        stats,
        transfers,
        usdtTransfers
      };
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
      console.log(`\n所有记录已保存到 ${OUTPUT_FILE}`);
      console.log(`最后区块: ${lastBlock}`);
      console.log(`提示: 运行 "npx ts-node src/utils/getBTCDTransfers.ts --to-csv" 可将 JSON 转换为 CSV`);

      const endTime = Date.now();
      const duration = (endTime - startTime) / 1000;
      console.log(`耗时: ${duration} 秒`);
    }
  } catch (error) {
    console.error('执行失败:', error);
    process.exit(1);
  }
}

/**
 * 将 JSON 文件转换为 CSV 文件
 */
function jsonToCsv(jsonFile: string = 'data/btcd_transfers.json', csvFile: string = 'data/btcd_transfers.csv') {
  if (!fs.existsSync(jsonFile)) {
    console.error(`文件不存在: ${jsonFile}`);
    process.exit(1);
  }

  console.log(`正在读取 ${jsonFile}...`);
  const rawData = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));

  // 兼容新旧格式
  const transfers: TransferRecord[] = rawData.transfers || rawData;

  const csvHeader = 'blockNumber,timestamp,timestampStr,from,to,value,valueRaw,transactionHash\n';
  const csvContent =
    csvHeader +
    transfers.map(t => `${t.blockNumber},${t.timestamp},${t.timestampStr},${t.from},${t.to},${t.value},${t.valueRaw},${t.transactionHash}`).join('\n');

  fs.writeFileSync(csvFile, csvContent);
  console.log(`已转换 ${transfers.length} 条记录到 ${csvFile}`);
}

// 根据命令行参数决定执行哪个功能
const args = process.argv.slice(2);
if (args.includes('--to-csv')) {
  // 转换 JSON 到 CSV
  const jsonFile = args[args.indexOf('--to-csv') + 1] || 'data/btcd_transfers.json';
  const csvFile = jsonFile.replace('.json', '.csv');
  jsonToCsv(jsonFile, csvFile);
} else {
  // 默认：获取 transfers
  main();
}

