/**
 * 查询 Issuer 对某个订单执行 closeOrder 的时间及对应交易 ID
 *
 * Order 合约在 closeOrder 被调用时会发出 OrderClosed 事件，事件从订单合约地址发出。
 * Issuer 调用 closeOrder(orderAddress) 时，Order 合约会执行并发出该事件。
 *
 * 使用方法:
 * npx ts-node getCloseOrderTx.ts --order 0x9f0e43c9b4cad5666ca49849f8dba9d9d871405a
 * npx ts-node getCloseOrderTx.ts --order 0x9f0e43c9b4cad5666ca49849f8dba9d9d871405a --network pgp-prod
 * npx ts-node getCloseOrderTx.ts --file data/pgp-prod/overdue_orders.json
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

import { getBlockTimestamps, timestampToStr } from './util';

// OrderClosed 事件签名 (Order 合约: event OrderClosed())
const ORDER_CLOSED_TOPIC = ethers.utils.id('OrderClosed()');

interface CloseOrderResult {
  orderId: string;
  blockNumber: number;
  timestamp: number;
  timestampStr: string;
  transactionHash: string;
  found: boolean;
}

function getNetworkFromArgs(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return 'pgp-prod';
}

function getOrderFromArgs(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--order' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

function getFileFromArgs(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

async function queryCloseOrderLogs(
  provider: any,
  orderAddress: string,
  startBlock: number
): Promise<{ log: any } | null> {
  const orderId = ethers.utils.getAddress(orderAddress);
  const currentBlock = await provider.getBlockNumber();

  const logs = await provider.getLogs({
    address: orderId,
    topics: [ORDER_CLOSED_TOPIC],
    fromBlock: startBlock,
    toBlock: currentBlock
  });

  if (logs.length === 0) {
    return null;
  }

  // 取第一条（理论上每个订单只会被 close 一次）
  return { log: logs[0] };
}

async function main(): Promise<void> {
  const network = getNetworkFromArgs();
  const orderArg = getOrderFromArgs();
  const fileArg = getFileFromArgs();

  if (!orderArg && !fileArg) {
    console.error('请指定 --order <订单地址> 或 --file <JSON文件路径>');
    console.error('示例:');
    console.error('  npx ts-node getCloseOrderTx.ts --order 0x9f0e43c9b4cad5666ca49849f8dba9d9d871405a');
    console.error('  npx ts-node getCloseOrderTx.ts --file data/pgp-prod/overdue_orders.json');
    process.exit(1);
  }

  const networkConfig = require('./network.json');
  const config = networkConfig[network];
  if (!config) {
    console.error(`未知网络: ${network}`);
    process.exit(1);
  }

  const { rpc_url: rpcUrl, start_block: startBlock } = config;
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  let orderIds: string[] = [];

  if (orderArg) {
    orderIds = [orderArg];
  } else if (fileArg) {
    const filePath = path.resolve(process.cwd(), fileArg);
    if (!fs.existsSync(filePath)) {
      console.error(`文件不存在: ${filePath}`);
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const items = Array.isArray(data) ? data : [data];
    orderIds = items.map((item: any) => item.orderId || item.order_id).filter(Boolean);
    if (orderIds.length === 0) {
      console.error(`文件中未找到 orderId 字段`);
      process.exit(1);
    }
    console.log(`从文件加载 ${orderIds.length} 个订单\n`);
  }

  console.log(`网络: ${network}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`起始区块: ${startBlock}`);
  console.log('');

  // 查询所有订单的 closeOrder 日志
  const rawResults: { orderId: string; log: any }[] = [];
  for (const orderId of orderIds) {
    const res = await queryCloseOrderLogs(provider, orderId, startBlock);
    if (res) {
      rawResults.push({ orderId: ethers.utils.getAddress(orderId), log: res.log });
    }
  }

  // 批量获取区块时间戳
  const blockNumbers = rawResults.map((r) => r.log.blockNumber);
  const blockTimestamps = blockNumbers.length > 0 ? await getBlockTimestamps(blockNumbers, rpcUrl) : new Map<number, number>();

  // 构建完整结果（包含未找到的订单）
  const foundOrderIds = new Set(rawResults.map((r) => r.orderId.toLowerCase()));
  const results: CloseOrderResult[] = orderIds.map((orderId) => {
    const normalized = ethers.utils.getAddress(orderId);
    const raw = rawResults.find((r) => r.orderId.toLowerCase() === normalized.toLowerCase());
    if (!raw) {
      return {
        orderId: normalized,
        blockNumber: 0,
        timestamp: 0,
        timestampStr: '',
        transactionHash: '',
        found: false
      };
    }
    const timestamp = blockTimestamps.get(raw.log.blockNumber) || 0;
    return {
      orderId: normalized,
      blockNumber: raw.log.blockNumber,
      timestamp,
      timestampStr: timestampToStr(timestamp),
      transactionHash: raw.log.transactionHash,
      found: true
    };
  });

  // 打印结果
  for (const result of results) {
    if (result.found) {
      console.log(`订单 ${result.orderId}:`);
      console.log(`  交易 ID: ${result.transactionHash}`);
      console.log(`  区块: ${result.blockNumber}`);
      console.log(`  时间: ${result.timestampStr}`);
    } else {
      console.log(`订单 ${result.orderId}: 未找到 closeOrder 记录`);
    }
  }

  // 输出 JSON 结果
  const outputDir = fileArg ? path.dirname(fileArg) : path.join('data', network);
  const outputPath = path.join(outputDir, 'close_order_tx.json');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n结果已保存到: ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
