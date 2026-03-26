/**
 * 监听 Order 合约的 TimeoutRepaymentMade 事件
 *
 * TimeoutRepaymentMade(address indexed repayer, string repayerBtcAddress)
 * 当订单超时后还款完成时，Order 合约会发出该事件。
 *
 * 使用方法:
 * npx ts-node listenTimeoutRepayment.ts
 * npx ts-node listenTimeoutRepayment.ts --network pgp-prod
 * npx ts-node listenTimeoutRepayment.ts --order 0xd45f432d8401fb628d5f257272470953e95f693c
 * npx ts-node listenTimeoutRepayment.ts --file data/pgp-prod/orders.json
 * npx ts-node listenTimeoutRepayment.ts --interval 6
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

import { timestampToStr } from './util';

// TimeoutRepaymentMade(address indexed repayer, string repayerBtcAddress)
const TIMEOUT_REPAYMENT_TOPIC = ethers.utils.id('TimeoutRepaymentMade(address,string)');

interface TimeoutRepaymentEvent {
  orderAddress: string;
  repayer: string;
  repayerBtcAddress: string;
  blockNumber: number;
  transactionHash: string;
  timestamp?: number;
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

function getIntervalFromArgs(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
      const val = parseInt(args[i + 1], 10);
      return isNaN(val) || val < 1 ? 12 : val;
    }
  }
  return 12;
}

function getFromBlockFromArgs(): number | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from-block' && args[i + 1]) {
      const val = parseInt(args[i + 1], 10);
      return isNaN(val) ? null : val;
    }
  }
  return null;
}

function parseTimeoutRepaymentLog(log: any): TimeoutRepaymentEvent {
  // topics[0] = event signature
  // topics[1] = repayer (indexed address, padded to 32 bytes)
  const repayer = ethers.utils.getAddress('0x' + log.topics[1].slice(26));
  const iface = new ethers.utils.Interface([
    'event TimeoutRepaymentMade(address indexed repayer, string repayerBtcAddress)'
  ]);
  const parsed = iface.parseLog(log);
  const repayerBtcAddress = parsed.args.repayerBtcAddress;
console.log('parsed log', parsed);
  return {
    orderAddress: log.address,
    repayer,
    repayerBtcAddress,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash
  };
}

function formatEvent(evt: TimeoutRepaymentEvent): string {
  const timeStr = evt.timestamp ? timestampToStr(evt.timestamp) : '';
  return [
    `[TimeoutRepaymentMade]`,
    `Order: ${evt.orderAddress}`,
    `Repayer: ${evt.repayer}`,
    `BTC Address: ${evt.repayerBtcAddress}`,
    `Block: ${evt.blockNumber}`,
    `Tx: ${evt.transactionHash}`,
    timeStr ? `Time: ${timeStr}` : ''
  ]
    .filter(Boolean)
    .join(' | ');
}

async function pollTimeoutRepaymentEvents(
  provider: any,
  lastBlockRef: { value: number },
  orderAddresses: string[] | null,
  rpcUrl: string,
  onEvent: (evt: TimeoutRepaymentEvent) => void
): Promise<void> {
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = lastBlockRef.value + 1;

  if (fromBlock > currentBlock) {
    return;
  }
console.log('fromBlock', fromBlock);
console.log('currentBlock', currentBlock);
console.log('TIMEOUT_REPAYMENT_TOPIC', TIMEOUT_REPAYMENT_TOPIC);

  const filter: any = {
    topics: [TIMEOUT_REPAYMENT_TOPIC],
    fromBlock,
    toBlock: currentBlock
  };

  if (orderAddresses && orderAddresses.length > 0) {
    filter.address = orderAddresses.map((a) => ethers.utils.getAddress(a));
  }

  const logs = await provider.getLogs(filter);

  if (logs.length > 0) {
    const { getBlockTimestamps } = await import('./util');
    const blockNumbers = Array.from(new Set(logs.map((l: any) => l.blockNumber))) as number[];
    const blockTimestamps = await getBlockTimestamps(blockNumbers, rpcUrl);

    for (const log of logs) {
      const evt = parseTimeoutRepaymentLog(log);
      evt.timestamp = blockTimestamps.get(log.blockNumber);
      onEvent(evt);
    }
  }

  lastBlockRef.value = currentBlock;
}

async function main(): Promise<void> {
  const network = getNetworkFromArgs();
  const orderArg = getOrderFromArgs();
  const fileArg = getFileFromArgs();
  const pollInterval = getIntervalFromArgs();
  const fromBlockArg = getFromBlockFromArgs();

  const networkConfig = require('./network.json');
  const config = networkConfig[network];
  if (!config) {
    console.error(`未知网络: ${network}`);
    process.exit(1);
  }

  const { rpc_url: rpcUrl, start_block: startBlock } = config;
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  let orderAddresses: string[] | null = null;
  if (orderArg) {
    orderAddresses = [ethers.utils.getAddress(orderArg)];
    console.log(`监听指定订单: ${orderAddresses[0]}`);
  } else if (fileArg) {
    const filePath = path.resolve(process.cwd(), fileArg);
    if (!fs.existsSync(filePath)) {
      console.error(`文件不存在: ${filePath}`);
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const items = Array.isArray(data) ? data : [data];
    orderAddresses = items
      .map((item: any) => item.orderId || item.order_id || item.orderAddress || item.address)
      .filter(Boolean)
      .map((a: string) => ethers.utils.getAddress(a));
    if (orderAddresses.length === 0) {
      console.error(`文件中未找到订单地址`);
      process.exit(1);
    }
    console.log(`从文件加载 ${orderAddresses.length} 个订单`);
  } else {
    console.log('监听所有 Order 合约的 TimeoutRepaymentMade 事件');
  }

  const lastBlockRef = { value: 0 };
  lastBlockRef.value = fromBlockArg ?? startBlock;

  console.log(`网络: ${network}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`轮询间隔: ${pollInterval} 秒`);
  console.log(`起始区块: ${lastBlockRef.value}`);
  console.log('--- 开始监听 ---\n');

  const onEvent = (evt: TimeoutRepaymentEvent) => {
    console.log(formatEvent(evt));
    console.log('');
  };

  // 先执行一次，处理历史事件
  await pollTimeoutRepaymentEvents(provider, lastBlockRef, orderAddresses, rpcUrl, onEvent);

  // 定时轮询
  setInterval(async () => {
    try {
      await pollTimeoutRepaymentEvents(provider, lastBlockRef, orderAddresses, rpcUrl, onEvent);
    } catch (err) {
      console.error('轮询出错:', err);
    }
  }, pollInterval * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
