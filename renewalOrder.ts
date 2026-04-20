/**
 * 查询 RenewalOrderRequested 事件（订单合约地址为 log.address）
 *
 * 未传 --order：不按合约过滤，拉取链上所有该 topic 的日志（依赖 RPC 是否允许大范围匿名 filter）。
 * 传 --order：仅查询该订单合约地址发出的日志。
 *
 * 使用方法:
 * npx ts-node renewalOrder.ts
 * npx ts-node renewalOrder.ts --network pgp-prod
 * npx ts-node renewalOrder.ts --order 0x... --network pgp-prod
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

import { getBlockTimestamps, timestampToStr } from './util';

const OrderArtifact = require('./abi/Order.json');
const orderInterface = new ethers.utils.Interface(OrderArtifact.abi);
/**
 * 事件 topic0 = keccak256(签名字符串)，签名字符串须与 Solidity 编译器一致：
 * - 形式为 `EventName(t1,t2,...)`，逗号后不能有空格（`address, uint256` 与 `address,uint256` 会得到不同 topic）。
 * - 应用 `Interface.getEventTopic` 从 artifact ABI 推导，避免手写偏差。
 * 若链上日志里的 topic0 与本常量仍不一致，说明部署合约与 ./abi/Order.json 不同步，需更新 ABI 或对照链上 artifact。
 */
const RENEWAL_ORDER_TOPIC = orderInterface.getEventTopic('RenewalOrderRequested');
console.log(RENEWAL_ORDER_TOPIC);
interface RenewalOrderResult {
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

/** orderAddress 为 null 时不按 address 过滤，返回链上所有匹配 topic 的日志 */
async function fetchRenewalOrderLogs(
  provider: any,
  orderAddress: string | null,
  startBlock: number
): Promise<any[]> {
  const currentBlock = await provider.getBlockNumber();
  const filter: { topics: string[]; fromBlock: number; toBlock: number; address?: string } = {
    topics: [RENEWAL_ORDER_TOPIC],
    fromBlock: startBlock,
    toBlock: currentBlock
  };
  if (orderAddress != null) {
    filter.address = ethers.utils.getAddress(orderAddress);
  }
  return provider.getLogs(filter);
}

function logsToResults(logs: any[], blockTimestamps: Map<number, number>): RenewalOrderResult[] {
  return logs.map((log) => {
    const timestamp = blockTimestamps.get(log.blockNumber) || 0;
    return {
      orderId: ethers.utils.getAddress(log.address),
      blockNumber: log.blockNumber,
      timestamp,
      timestampStr: timestampToStr(timestamp),
      transactionHash: log.transactionHash,
      found: true
    };
  });
}

const PRINT_LIMIT = 50;

async function main(): Promise<void> {
  const network = getNetworkFromArgs();
  const orderArg = getOrderFromArgs();

  const networkConfig = require('./network.json');
  const config = networkConfig[network];
  if (!config) {
    console.error(`未知网络: ${network}`);
    process.exit(1);
  }

  const { rpc_url: rpcUrl, start_block: startBlock } = config;
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  console.log(`网络: ${network}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`起始区块: ${startBlock}`);
  console.log(orderArg ? `订单过滤: ${orderArg}` : '模式: 全链 RenewalOrderRequested（未指定 --order）');
  console.log('');

  const logs = await fetchRenewalOrderLogs(provider, orderArg, startBlock);

  let results: RenewalOrderResult[];

  if (orderArg && logs.length === 0) {
    results = [
      {
        orderId: ethers.utils.getAddress(orderArg),
        blockNumber: 0,
        timestamp: 0,
        timestampStr: '',
        transactionHash: '',
        found: false
      }
    ];
  } else {
    const blockNumbers = [...new Set(logs.map((l: any) => l.blockNumber as number))];
    const blockTimestamps =
      blockNumbers.length > 0 ? await getBlockTimestamps(blockNumbers, rpcUrl) : new Map<number, number>();
    results = logsToResults(logs, blockTimestamps);
  }

  if (results.length === 0) {
    console.log('未找到任何 RenewalOrderRequested 事件');
  } else {
    const toShow = results.slice(0, PRINT_LIMIT);
    for (const result of toShow) {
      if (result.found) {
        console.log(`订单 ${result.orderId}:`);
        console.log(`  交易 ID: ${result.transactionHash}`);
        console.log(`  区块: ${result.blockNumber}`);
        console.log(`  时间: ${result.timestampStr}`);
      } else {
        console.log(`订单 ${result.orderId}: 未找到 renewalOrder 记录`);
      }
    }
    if (results.length > PRINT_LIMIT) {
      console.log(`\n（控制台仅显示前 ${PRINT_LIMIT} 条，共 ${results.length} 条，完整结果见 JSON）`);
    }
  }

  const outputDir = path.join('data', network);
  const outputPath = path.join(outputDir, 'renewal_order_tx.json');
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
