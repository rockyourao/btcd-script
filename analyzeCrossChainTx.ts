/**
 * 分析跨链交易，找出事件签名
 *
 * npx ts-node analyzeCrossChainTx.ts 0x246e9504e0a4522671c85cee229dd50cffa51be218936371de70bdb0dee9f539
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from 'ethers';

const RPC_URL = 'https://api.elastos.cc/eco';

async function main() {
  const txHash = process.argv[2] || '0x246e9504e0a4522671c85cee229dd50cffa51be218936371de70bdb0dee9f539';

  console.log(`\n===== 分析跨链交易 =====`);
  console.log(`交易哈希: ${txHash}`);

  const provider = new (ethers as any).providers.JsonRpcProvider(RPC_URL);

  // 获取交易详情
  const tx = await provider.getTransaction(txHash);
  console.log(`\n交易基本信息:`);
  console.log(`  From: ${tx.from}`);
  console.log(`  To: ${tx.to}`);
  console.log(`  Value: ${(ethers as any).utils.formatEther(tx.value)} ELA`);
  console.log(`  Block: ${tx.blockNumber}`);

  // 获取交易收据（包含事件日志）
  const receipt = await provider.getTransactionReceipt(txHash);
  console.log(`\n交易状态: ${receipt.status === 1 ? '成功' : '失败'}`);
  console.log(`Gas Used: ${receipt.gasUsed.toString()}`);

  console.log(`\n===== 事件日志 (${receipt.logs.length} 个) =====`);

  // 常见的跨链事件签名
  const knownEvents: { [key: string]: string } = {
    // ERC20 Transfer
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': 'Transfer(address,address,uint256)',
    // 常见跨链桥事件
    '0x9b1bfa7fa9ee420a16e124f794c35ac9f90472acc99140eb2f6447c714cad8eb': 'CrossChain(address,uint256,...)',
    '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c': 'Deposit(address,uint256)',
    '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65': 'Withdrawal(address,uint256)',
  };

  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i];
    console.log(`\n--- 事件 #${i + 1} ---`);
    console.log(`  合约地址: ${log.address}`);
    console.log(`  Topics:`);
    for (let j = 0; j < log.topics.length; j++) {
      const topic = log.topics[j];
      const knownEvent = j === 0 ? knownEvents[topic] : null;
      console.log(`    [${j}]: ${topic}${knownEvent ? ` (${knownEvent})` : ''}`);
    }
    if (log.data && log.data !== '0x') {
      console.log(`  Data: ${log.data.slice(0, 66)}...`);
    }
  }

  // 提取所有唯一的事件签名（topic[0]）
  const uniqueTopics = [...new Set(receipt.logs.map((log: any) => log.topics[0]))];
  console.log(`\n===== 唯一的事件签名 (${uniqueTopics.length} 个) =====`);
  for (const topic of uniqueTopics) {
    const known = knownEvents[topic as string];
    console.log(`${topic}${known ? ` => ${known}` : ''}`);
  }

  // 提取所有涉及的合约地址
  const uniqueContracts = [...new Set(receipt.logs.map((log: any) => log.address))];
  console.log(`\n===== 涉及的合约地址 (${uniqueContracts.length} 个) =====`);
  for (const addr of uniqueContracts) {
    console.log(`${addr}`);
    console.log(`  浏览器: https://eco.elastos.io/address/${addr}`);
  }
}

main().catch(console.error);

