/**
 * 获取 StakingFactory 合约的 StakingContractCreated 事件并读取 Staking 合约详细信息
 *
 * 使用方法:
 * npx ts-node btcdStakingStats.ts
 * npx ts-node btcdStakingStats.ts --network pgp-prod  # 指定网络
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from 'ethers';
import { formatWithCommas, timestampToStr, topicToAddress } from './util';
const fs = require('fs');


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
const STAKING_FACTORY_ADDRESS = networkConfig[network].staking_factory_address;
const MULTICALL3_ADDRESS = networkConfig[network].multicall3;
const INITIAL_START_BLOCK = networkConfig[network].start_block;
const BATCH_SIZE = networkConfig[network].batch_size;
const RPC_URL = networkConfig[network].rpc_url;
const STAKING_TOKEN1_DECIMALS = networkConfig[network].stakingToken1_decimals;
const STAKING_TOKEN2_DECIMALS = networkConfig[network].stakingToken2_decimals;

// 加载合约 ABI
const stakingFactoryAbi = require('./abi/StakingFactory.json').abi;
const stakingAbi = require('./abi/Staking.json').abi;
const multicall3Abi = require('./abi/Multicall3.json').abi;

// StakingContractCreated 事件签名
// event StakingContractCreated(address indexed user, address stakingContract)
const STAKING_CONTRACT_CREATED_TOPIC = ethers.utils.id('StakingContractCreated(address,address)');

// Staking 合约事件签名
// event Staked(address indexed user, uint256 ethAmount, uint256 token1Amount, uint256 token2Amount, uint256 endTime)
const STAKED_TOPIC = ethers.utils.id('Staked(address,uint256,uint256,uint256,uint256)');
// event Withdrawn(address indexed user, uint256 ethAmount, uint256 token1Amount, uint256 token2Amount)
const WITHDRAWN_TOPIC = ethers.utils.id('Withdrawn(address,uint256,uint256,uint256)');
// event StakeExtended(address indexed user, uint256 newEndTime)
const STAKE_EXTENDED_TOPIC = ethers.utils.id('StakeExtended(address,uint256)');
// ERC20 Transfer 事件签名
// event Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

// Multicall 批次大小
const MULTICALL_BATCH_SIZE = 200;

// Token Transfer 事件记录（转入 Staking 合约）
interface TokenTransfer {
  type: 'TransferIn' | 'TransferOut';  // 转入或转出 Staking 合约
  from: string;
  to: string;
  originalFrom?: string;  // 同一交易中的原始来源（追踪通过 Factory 的转账）
  originalTo?: string;    // 同一交易中的最终去向（追踪通过 Factory 的转账）
  value: string;          // 格式化后的值
  valueRaw: string;       // 原始值
  blockNumber: number;
  transactionHash: string;
  tokenAddress: string;   // Token 合约地址
  // 同一交易中关联的其他 token 转移（从 Staked/Withdrawn 事件中获取）
  relatedEthAmount?: string;    // Native token (ETH/ELA) 数量
  relatedToken1Amount?: string; // Token1 数量
  relatedToken2Amount?: string; // Token2 数量
}

interface StakingRecord {
  stakingContract: string;   // Staking 合约地址
  user: string;              // 用户地址
  blockNumber: number;
  transactionHash: string;
  // Staking 合约详细信息
  details?: StakingDetails;
  // Staking 事件历史
  events?: StakingEvent[];
  // Token 转账记录（转入/转出 Staking 合约）
  tokenTransfers?: TokenTransfer[];
}

interface StakingDetails {
  owner: string;
  ethAmount: string;         // ETH 数量 (格式化后)
  ethAmountRaw: string;      // ETH 数量 (原始值)
  token1Amount: string;      // Token1 数量 (格式化后)
  token1AmountRaw: string;   // Token1 数量 (原始值)
  token2Amount: string;      // Token2 数量 (格式化后)
  token2AmountRaw: string;   // Token2 数量 (原始值)
  startTime: number;
  startTimeStr: string;
  endTime: number;
  endTimeStr: string;
  isActive: boolean;
}

interface StakingEvent {
  type: 'Staked' | 'Withdrawn' | 'StakeExtended';
  stakingContract: string;
  user: string;
  blockNumber: number;
  transactionHash: string;
  // Staked 事件数据
  ethAmount?: string;
  token1Amount?: string;
  token2Amount?: string;
  endTime?: number;
  // StakeExtended 事件数据
  newEndTime?: number;
}

/**
 * 使用 JSON-RPC 批量请求获取多个合约的事件
 * 这是获取大量合约事件的最快方法
 */
async function fetchStakingEventsWithBatchRpc(
  stakingContracts: string[],
  startBlock: number,
  endBlock: number
): Promise<StakingEvent[]> {
  const allEvents: StakingEvent[] = [];
  const stakingInterface = new ethers.utils.Interface(stakingAbi);

  // 所有三种事件的 topics
  const eventTopics = [
    [STAKED_TOPIC],
    [WITHDRAWN_TOPIC],
    [STAKE_EXTENDED_TOPIC]
  ];

  console.log(`\n使用 JSON-RPC 批量请求获取 ${stakingContracts.length} 个 Staking 合约的事件...`);

  // 每批处理的合约数量
  const CONTRACTS_PER_BATCH = 50;

  for (let i = 0; i < stakingContracts.length; i += CONTRACTS_PER_BATCH) {
    const batchContracts = stakingContracts.slice(i, i + CONTRACTS_PER_BATCH);

    // 构建批量请求：每个合约查询 3 种事件
    const batchRequest: any[] = [];
    let requestId = 0;

    for (const contractAddr of batchContracts) {
      for (const topics of eventTopics) {
        batchRequest.push({
          jsonrpc: '2.0',
          id: requestId++,
          method: 'eth_getLogs',
          params: [{
            address: contractAddr,
            topics: topics,
            fromBlock: '0x' + startBlock.toString(16),
            toBlock: '0x' + endBlock.toString(16)
          }]
        });
      }
    }

    try {
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchRequest)
      });

      const results = await response.json() as any[];

      // 解析结果
      for (const result of results) {
        if (result.result && Array.isArray(result.result)) {
          for (const log of result.result) {
            const contractAddr = log.address.toLowerCase();
            const eventTopic = log.topics[0];
            const blockNumber = parseInt(log.blockNumber, 16);
            const user = topicToAddress(log.topics[1]);

            try {
              if (eventTopic === STAKED_TOPIC) {
                const decoded = stakingInterface.decodeEventLog('Staked', log.data, log.topics);
                allEvents.push({
                  type: 'Staked',
                  stakingContract: contractAddr,
                  user,
                  blockNumber,
                  transactionHash: log.transactionHash,
                  ethAmount: ethers.utils.formatEther(decoded.ethAmount),
                  token1Amount: ethers.utils.formatUnits(decoded.token1Amount, STAKING_TOKEN1_DECIMALS),
                  token2Amount: ethers.utils.formatUnits(decoded.token2Amount, STAKING_TOKEN2_DECIMALS),
                  endTime: decoded.endTime.toNumber()
                });
              } else if (eventTopic === WITHDRAWN_TOPIC) {
                const decoded = stakingInterface.decodeEventLog('Withdrawn', log.data, log.topics);
                allEvents.push({
                  type: 'Withdrawn',
                  stakingContract: contractAddr,
                  user,
                  blockNumber,
                  transactionHash: log.transactionHash,
                  ethAmount: ethers.utils.formatEther(decoded.ethAmount),
                  token1Amount: ethers.utils.formatUnits(decoded.token1Amount, STAKING_TOKEN1_DECIMALS),
                  token2Amount: ethers.utils.formatUnits(decoded.token2Amount, STAKING_TOKEN2_DECIMALS)
                });
              } else if (eventTopic === STAKE_EXTENDED_TOPIC) {
                const decoded = stakingInterface.decodeEventLog('StakeExtended', log.data, log.topics);
                allEvents.push({
                  type: 'StakeExtended',
                  stakingContract: contractAddr,
                  user,
                  blockNumber,
                  transactionHash: log.transactionHash,
                  newEndTime: decoded.newEndTime.toNumber()
                });
              }
            } catch (decodeError) {
              console.error(`解码事件失败:`, decodeError);
            }
          }
        }
      }

      const progress = Math.min(i + CONTRACTS_PER_BATCH, stakingContracts.length);
      console.log(`已处理: ${progress}/${stakingContracts.length} 个合约 (${((progress / stakingContracts.length) * 100).toFixed(1)}%), 累计事件: ${allEvents.length}`);
    } catch (error) {
      console.error(`批量请求失败 (合约 ${i} - ${i + CONTRACTS_PER_BATCH}):`, error);
    }
  }

  console.log(`总共获取到 ${allEvents.length} 个 Staking 事件`);
  return allEvents;
}

/**
 * 快速获取所有 Staking 事件（不限制地址，通过事件签名查询）
 * 这是最快的方法，适用于事件唯一的情况
 */
async function fetchAllStakingEventsFast(
  provider: any,
  startBlock: number,
  endBlock: number,
  validContracts: Set<string>
): Promise<StakingEvent[]> {
  const allEvents: StakingEvent[] = [];
  const stakingInterface = new ethers.utils.Interface(stakingAbi);

  console.log(`\n快速获取 Staking 事件 (区块 ${startBlock} - ${endBlock})...`);

  // 查询所有三种事件
  const eventConfigs = [
    { topic: STAKED_TOPIC, name: 'Staked' },
    { topic: WITHDRAWN_TOPIC, name: 'Withdrawn' },
    { topic: STAKE_EXTENDED_TOPIC, name: 'StakeExtended' }
  ];

  for (const config of eventConfigs) {
    console.log(`查询 ${config.name} 事件...`);

    for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += BATCH_SIZE) {
      const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, endBlock);

      try {
        const logs = await provider.getLogs({
          topics: [config.topic],
          fromBlock,
          toBlock
        });

        for (const log of logs) {
          const contractAddr = log.address.toLowerCase();

          // 只处理已知的 Staking 合约
          if (!validContracts.has(contractAddr)) continue;

          const blockNumber = log.blockNumber;
          const user = topicToAddress(log.topics[1]);

          try {
            if (config.topic === STAKED_TOPIC) {
              const decoded = stakingInterface.decodeEventLog('Staked', log.data, log.topics);
              allEvents.push({
                type: 'Staked',
                stakingContract: contractAddr,
                user,
                blockNumber,
                transactionHash: log.transactionHash,
                ethAmount: ethers.utils.formatEther(decoded.ethAmount),
                token1Amount: ethers.utils.formatUnits(decoded.token1Amount, STAKING_TOKEN1_DECIMALS),
                token2Amount: ethers.utils.formatUnits(decoded.token2Amount, STAKING_TOKEN2_DECIMALS),
                endTime: decoded.endTime.toNumber()
              });
            } else if (config.topic === WITHDRAWN_TOPIC) {
              const decoded = stakingInterface.decodeEventLog('Withdrawn', log.data, log.topics);
              allEvents.push({
                type: 'Withdrawn',
                stakingContract: contractAddr,
                user,
                blockNumber,
                transactionHash: log.transactionHash,
                ethAmount: ethers.utils.formatEther(decoded.ethAmount),
                token1Amount: ethers.utils.formatUnits(decoded.token1Amount, STAKING_TOKEN1_DECIMALS),
                token2Amount: ethers.utils.formatUnits(decoded.token2Amount, STAKING_TOKEN2_DECIMALS)
              });
            } else if (config.topic === STAKE_EXTENDED_TOPIC) {
              const decoded = stakingInterface.decodeEventLog('StakeExtended', log.data, log.topics);
              allEvents.push({
                type: 'StakeExtended',
                stakingContract: contractAddr,
                user,
                blockNumber,
                transactionHash: log.transactionHash,
                newEndTime: decoded.newEndTime.toNumber()
              });
            }
          } catch (decodeError) {
            // 解码失败，可能不是我们的合约
          }
        }

        if (logs.length > 0) {
          console.log(`  区块 ${fromBlock} - ${toBlock}: 找到 ${logs.length} 条 ${config.name} 日志`);
        }
      } catch (error) {
        console.error(`查询 ${config.name} 事件失败 (区块 ${fromBlock} - ${toBlock}):`, error);
      }
    }
  }

  console.log(`总共获取到 ${allEvents.length} 个有效 Staking 事件`);
  return allEvents;
}

/**
 * 从 StakingFactory 获取 Token1 和 Token2 地址
 */
async function getStakingTokenAddresses(provider: any): Promise<{ token1: string; token2: string }> {
  const factoryContract = new ethers.Contract(STAKING_FACTORY_ADDRESS, stakingFactoryAbi, provider);

  try {
    const [token1, token2] = await Promise.all([
      factoryContract.stakingToken1(),
      factoryContract.stakingToken2()
    ]);
    return {
      token1: token1.toLowerCase(),
      token2: token2.toLowerCase()
    };
  } catch (error) {
    console.error('获取 Staking Token 地址失败:', error);
    return { token1: '', token2: '' };
  }
}

/**
 * 获取 Token Transfer 事件（转入/转出 Staking 合约）
 * 追踪 Staking Token (Token1/Token2) 在用户地址和 Staking 合约之间的流动
 */
async function fetchTokenTransfers(
  provider: any,
  startBlock: number,
  endBlock: number,
  stakingContracts: Set<string>,
  stakingFactoryAddress: string,
  tokenAddresses: string[]
): Promise<TokenTransfer[]> {
  const allTransfers: TokenTransfer[] = [];

  console.log(`\n获取 Token Transfer 事件 (区块 ${startBlock} - ${endBlock})...`);
  console.log(`追踪 Token 地址: ${tokenAddresses.join(', ')}`);
  console.log(`监控 ${stakingContracts.size} 个 Staking 合约的 Transfer 事件`);

  // 创建包含 Staking 合约和 Factory 的地址集合
  const relevantAddresses = new Set(stakingContracts);
  relevantAddresses.add(stakingFactoryAddress.toLowerCase());

  // 对每个 token 地址查询 Transfer 事件
  for (const tokenAddress of tokenAddresses) {
    if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') continue;

    console.log(`\n  查询 Token ${tokenAddress} 的 Transfer 事件...`);

    // 分批处理避免 RPC 限制
    for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += BATCH_SIZE) {
      const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, endBlock);

      try {
        // 获取此 Token 的 Transfer 事件
        const logs = await provider.getLogs({
          address: tokenAddress,
          topics: [TRANSFER_TOPIC],
          fromBlock,
          toBlock
        });

        let batchRelated = 0;
        for (const log of logs) {
          // 解析 from 和 to 地址
          const from = topicToAddress(log.topics[1]);
          const to = topicToAddress(log.topics[2]);

          // 检查是否与 Staking 合约或 Factory 相关
          const isFromRelevant = relevantAddresses.has(from);
          const isToRelevant = relevantAddresses.has(to);

          if (!isFromRelevant && !isToRelevant) continue;

          // 解析转账金额
          const value = ethers.BigNumber.from(log.data);

          // 确定 Transfer 类型
          // TransferIn: 转入到 Staking 合约
          // TransferOut: 从 Staking 合约转出
          let type: 'TransferIn' | 'TransferOut';
          if (stakingContracts.has(to)) {
            type = 'TransferIn';
          } else if (stakingContracts.has(from)) {
            type = 'TransferOut';
          } else {
            // 与 Factory 相关但不直接与 Staking 合约相关，也记录
            type = isToRelevant ? 'TransferIn' : 'TransferOut';
          }

          const transfer: TokenTransfer = {
            type,
            from,
            to,
            value: ethers.utils.formatUnits(value, 18), // 默认 18 位小数
            valueRaw: value.toString(),
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            tokenAddress: tokenAddress.toLowerCase()
          };

          allTransfers.push(transfer);
          batchRelated++;
        }

        if (batchRelated > 0) {
          console.log(`    区块 ${fromBlock} - ${toBlock}: 找到 ${batchRelated} 条相关 Transfer`);
        }
      } catch (error) {
        console.error(`  查询 Transfer 事件失败 (区块 ${fromBlock} - ${toBlock}):`);
        // console.error(`  查询 Transfer 事件失败 (区块 ${fromBlock} - ${toBlock}):`, error);
      }
    }
  }

  console.log(`\n总共获取到 ${allTransfers.length} 条与 Staking 合约相关的 Token Transfer 事件`);

  // 追踪同一交易中的原始来源/去向
  // 按交易哈希分组
  const transfersByTx = new Map<string, TokenTransfer[]>();
  for (const transfer of allTransfers) {
    const txHash = transfer.transactionHash;
    if (!transfersByTx.has(txHash)) {
      transfersByTx.set(txHash, []);
    }
    transfersByTx.get(txHash)!.push(transfer);
  }

  // 对于每个交易，追踪通过 Factory 的转账的原始来源
  const factoryAddr = stakingFactoryAddress.toLowerCase();
  for (const [txHash, transfers] of transfersByTx) {
    if (transfers.length < 2) continue;

    // 找出通过 Factory 的转账链
    // 例如: A -> Factory -> B，则 B 的 TransferIn 的 originalFrom 应该是 A
    for (const transfer of transfers) {
      if (transfer.type === 'TransferIn' && transfer.from === factoryAddr) {
        // 这是从 Factory 转入的，找原始来源
        // 查找同一交易中转入 Factory 的 Transfer
        const sourceTransfer = transfers.find(t =>
          t.to === factoryAddr &&
          t.valueRaw === transfer.valueRaw &&
          t.tokenAddress === transfer.tokenAddress
        );
        if (sourceTransfer) {
          transfer.originalFrom = sourceTransfer.from;
        }
      }

      if (transfer.type === 'TransferOut' && transfer.to === factoryAddr) {
        // 这是转出到 Factory 的，找最终去向
        // 查找同一交易中从 Factory 转出的 Transfer
        const destTransfer = transfers.find(t =>
          t.from === factoryAddr &&
          t.valueRaw === transfer.valueRaw &&
          t.tokenAddress === transfer.tokenAddress
        );
        if (destTransfer) {
          transfer.originalTo = destTransfer.to;
        }
      }
    }
  }

  console.log(`已追踪同一交易中的原始来源/去向`);
  return allTransfers;
}

/**
 * 使用 Multicall3 批量获取 Staking 合约详细信息
 */
async function fetchStakingDetailsWithMulticall(
  provider: any,
  stakingContracts: string[]
): Promise<Map<string, StakingDetails>> {
  const stakingDetailsMap = new Map<string, StakingDetails>();
  const stakingInterface = new ethers.utils.Interface(stakingAbi);
  const multicall3 = new ethers.Contract(MULTICALL3_ADDRESS, multicall3Abi, provider);

  // 每个 Staking 合约需要调用的函数
  const functionNames = [
    'owner',
    'ethAmount',
    'token1Amount',
    'token2Amount',
    'startTime',
    'endTime',
    'isActive'
  ];

  console.log(`\n使用 Multicall3 获取 ${stakingContracts.length} 个 Staking 合约的详细信息...`);
  // console.log(`Multicall3 地址: ${MULTICALL3_ADDRESS}`);
  console.log(`每批次处理: ${MULTICALL_BATCH_SIZE} 个合约`);

  // 分批处理
  for (let i = 0; i < stakingContracts.length; i += MULTICALL_BATCH_SIZE) {
    const batchContracts = stakingContracts.slice(i, i + MULTICALL_BATCH_SIZE);
    const calls: any[] = [];

    // 为每个 Staking 合约构建调用数据
    for (const contractAddr of batchContracts) {
      for (const funcName of functionNames) {
        const callData = stakingInterface.encodeFunctionData(funcName);
        calls.push({
          target: contractAddr,
          allowFailure: true,
          callData
        });
      }
    }

    try {
      const results = await multicall3.aggregate3(calls);

      // 解析结果
      let resultIdx = 0;
      for (const contractAddr of batchContracts) {
        try {
          const ownerResult = results[resultIdx++];
          const ethAmountResult = results[resultIdx++];
          const token1AmountResult = results[resultIdx++];
          const token2AmountResult = results[resultIdx++];
          const startTimeResult = results[resultIdx++];
          const endTimeResult = results[resultIdx++];
          const isActiveResult = results[resultIdx++];

          // 解码各个字段
          const owner = ownerResult.success
            ? stakingInterface.decodeFunctionResult('owner', ownerResult.returnData)[0]
            : '';

          const ethAmountRaw = ethAmountResult.success
            ? stakingInterface.decodeFunctionResult('ethAmount', ethAmountResult.returnData)[0].toString()
            : '0';

          const token1AmountRaw = token1AmountResult.success
            ? stakingInterface.decodeFunctionResult('token1Amount', token1AmountResult.returnData)[0].toString()
            : '0';

          const token2AmountRaw = token2AmountResult.success
            ? stakingInterface.decodeFunctionResult('token2Amount', token2AmountResult.returnData)[0].toString()
            : '0';

          const startTime = startTimeResult.success
            ? stakingInterface.decodeFunctionResult('startTime', startTimeResult.returnData)[0].toNumber()
            : 0;

          const endTime = endTimeResult.success
            ? stakingInterface.decodeFunctionResult('endTime', endTimeResult.returnData)[0].toNumber()
            : 0;

          const isActive = isActiveResult.success
            ? stakingInterface.decodeFunctionResult('isActive', isActiveResult.returnData)[0]
            : false;

          stakingDetailsMap.set(contractAddr.toLowerCase(), {
            owner,
            ethAmount: ethers.utils.formatEther(ethAmountRaw),
            ethAmountRaw,
            token1Amount: ethers.utils.formatUnits(token1AmountRaw, STAKING_TOKEN1_DECIMALS),
            token1AmountRaw,
            token2Amount: ethers.utils.formatUnits(token2AmountRaw, STAKING_TOKEN2_DECIMALS),
            token2AmountRaw,
            startTime,
            startTimeStr: timestampToStr(startTime),
            endTime,
            endTimeStr: timestampToStr(endTime),
            isActive
          });
        } catch (decodeError) {
          console.error(`解码 Staking 合约 ${contractAddr} 详情失败:`, decodeError);
        }
      }

      const progress = Math.min(i + MULTICALL_BATCH_SIZE, stakingContracts.length);
      console.log(`已处理: ${progress}/${stakingContracts.length} (${((progress / stakingContracts.length) * 100).toFixed(1)}%)`);
    } catch (error) {
      console.error(`Multicall 批次 ${i} - ${i + MULTICALL_BATCH_SIZE} 失败:`, error);
    }
  }

  console.log(`成功获取 ${stakingDetailsMap.size} 个 Staking 合约的详细信息`);
  return stakingDetailsMap;
}

/**
 * 解析 StakingContractCreated 事件日志
 */
function parseStakingLogs(logs: any[]): StakingRecord[] {
  return logs.map((log: any) => {
    // indexed 参数在 topics 中
    const user = topicToAddress(log.topics[1]);

    // 非 indexed 参数在 data 中解码
    const iface = new ethers.utils.Interface(stakingFactoryAbi);
    const decoded = iface.decodeEventLog('StakingContractCreated', log.data, log.topics);

    return {
      stakingContract: decoded.stakingContract.toLowerCase(),
      user,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash
    };
  });
}

/**
 * 获取所有 StakingContractCreated 事件
 */
async function getStakingContractCreatedLogs(
  provider: any,
  currentBlock: number,
  beforeBlock?: number
): Promise<StakingRecord[]> {
  const endBlock = currentBlock;
  const startBlock = beforeBlock ? beforeBlock : INITIAL_START_BLOCK;

  console.log(`\n合约地址: ${STAKING_FACTORY_ADDRESS}`);
  console.log(`事件签名: ${STAKING_CONTRACT_CREATED_TOPIC}`);
  console.log(`从区块 ${startBlock} 到 ${endBlock} 搜索...`);

  const allLogs: any[] = [];
  const topics = [STAKING_CONTRACT_CREATED_TOPIC];

  // 从起始区块向前搜索
  for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += BATCH_SIZE) {
    const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, endBlock);

    try {
      const logs = await provider.getLogs({
        address: STAKING_FACTORY_ADDRESS,
        topics: topics,
        fromBlock,
        toBlock
      });

      if (logs.length > 0) {
        allLogs.push(...logs);
        console.log(`区块 ${fromBlock} - ${toBlock}: 找到 ${logs.length} 条 (累计: ${allLogs.length})`);
      }
    } catch (error) {
      console.error(`查询区块 ${fromBlock} - ${toBlock} 失败:`, error);
      // 尝试更小的批次
      const SMALLER_BATCH = 10000;
      for (let subFrom = fromBlock; subFrom <= toBlock; subFrom += SMALLER_BATCH) {
        const subTo = Math.min(subFrom + SMALLER_BATCH - 1, toBlock);
        try {
          const logs = await provider.getLogs({
            address: STAKING_FACTORY_ADDRESS,
            topics: topics,
            fromBlock: subFrom,
            toBlock: subTo
          });
          if (logs.length > 0) {
            allLogs.push(...logs);
            console.log(`区块 ${subFrom} - ${subTo}: 找到 ${logs.length} 条 (累计: ${allLogs.length})`);
          }
        } catch (subError) {
          console.error(`查询区块 ${subFrom} - ${subTo} 失败:`, subError);
        }
      }
    }
  }

  console.log(`\n总共获取到 ${allLogs.length} 条 StakingContractCreated 事件日志`);

  if (allLogs.length === 0) {
    return [];
  }

  // 按区块号升序排序
  allLogs.sort((a: any, b: any) => a.blockNumber - b.blockNumber);

  return parseStakingLogs(allLogs);
}

async function main() {
  const startTime = Date.now();
  console.log('\n===== 获取 StakingContractCreated 事件 =====');

  const provider = new (ethers as any).providers.JsonRpcProvider(RPC_URL);
  const outputFile = `data/${network}/btcd_staking_stats.json`;

  const currentBlock: number = await provider.getBlockNumber();
  console.log(`当前区块高度: ${currentBlock}`);

  // 1. 从已有数据文件中读取数据
  let existingRecords: StakingRecord[] = [];
  let savedCurrentBlock = 0;

  try {
    if (fs.existsSync(outputFile)) {
      console.log(`\n读取已有数据文件: ${outputFile}`);
      const savedData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      if (savedData.records && Array.isArray(savedData.records)) {
        existingRecords = savedData.records;
        console.log(`已读取 ${existingRecords.length} 条现有 Staking 记录`);
      }
      if (savedData.currentBlock) {
        savedCurrentBlock = savedData.currentBlock;
        console.log(`上次同步的区块高度: ${savedCurrentBlock}`);
      }
    }
  } catch (error) {
    console.error(`读取 ${outputFile} 失败:`, error);
  }

  // 2. 获取新创建的 Staking 合约
  const beforeBlock = savedCurrentBlock > 0 ? savedCurrentBlock : undefined;
  console.log(`\n获取从区块 ${beforeBlock ? beforeBlock : INITIAL_START_BLOCK} 到 ${currentBlock} 的新 Staking 合约...`);
  const newRecords = await getStakingContractCreatedLogs(provider, currentBlock, beforeBlock);

  console.log(`\n找到 ${newRecords.length} 个新 Staking 合约`);

  // 3. 合并数据
  const existingRecordsMap = new Map<string, StakingRecord>();
  for (const record of existingRecords) {
    existingRecordsMap.set(record.stakingContract.toLowerCase(), record);
  }

  // 添加新记录
  for (const newRecord of newRecords) {
    const contractAddr = newRecord.stakingContract.toLowerCase();
    if (!existingRecordsMap.has(contractAddr)) {
      existingRecordsMap.set(contractAddr, newRecord);
    }
  }

  // 转换为数组
  const allRecords = Array.from(existingRecordsMap.values());
  allRecords.sort((a, b) => a.blockNumber - b.blockNumber);

  // 4. 获取 Staking Token 地址
  console.log(`\n获取 Staking Token 地址...`);
  const stakingTokens = await getStakingTokenAddresses(provider);
  console.log(`Token1: ${stakingTokens.token1}`);
  console.log(`Token2: ${stakingTokens.token2}`);

  // 5. 获取事件（增量更新）
  const stakingContracts = allRecords.map(r => r.stakingContract);
  const validContractsSet = new Set(stakingContracts.map(c => c.toLowerCase()));

  // 确定事件查询的起始区块
  const eventStartBlock = savedCurrentBlock > 0 ? savedCurrentBlock + 1 : INITIAL_START_BLOCK;

  // 收集已有的事件
  const existingEventsMap = new Map<string, StakingEvent[]>();
  for (const record of existingRecords) {
    if (record.events && record.events.length > 0) {
      existingEventsMap.set(record.stakingContract.toLowerCase(), record.events);
    }
  }

  // 只获取新区块范围内的事件
  let newEvents: StakingEvent[] = [];
  if (eventStartBlock <= currentBlock) {
    console.log(`\n获取从区块 ${eventStartBlock} 到 ${currentBlock} 的新事件...`);
    newEvents = await fetchAllStakingEventsFast(
      provider,
      eventStartBlock,
      currentBlock,
      validContractsSet
    );
  } else {
    console.log(`\n没有新区块需要获取事件`);
  }

  // 将新事件按合约分组
  const newEventsMap = new Map<string, StakingEvent[]>();
  for (const event of newEvents) {
    const contractAddr = event.stakingContract.toLowerCase();
    if (!newEventsMap.has(contractAddr)) {
      newEventsMap.set(contractAddr, []);
    }
    newEventsMap.get(contractAddr)!.push(event);
  }

  // 6. 获取有更新的 Staking 合约的详细信息（只更新新合约和有新事件的合约）
  const contractsToUpdate = new Set<string>();
  // 添加新创建的合约
  for (const newRecord of newRecords) {
    contractsToUpdate.add(newRecord.stakingContract.toLowerCase());
  }
  // 添加有新事件的合约
  for (const contractAddr of newEventsMap.keys()) {
    contractsToUpdate.add(contractAddr);
  }

  const contractsToUpdateArray = Array.from(contractsToUpdate);
  if (contractsToUpdateArray.length > 0) {
    console.log(`\n获取 ${contractsToUpdateArray.length} 个合约的详细信息（新合约: ${newRecords.length}, 有新事件: ${newEventsMap.size}）...`);
    const detailsMap = await fetchStakingDetailsWithMulticall(provider, contractsToUpdateArray);

    // 将详情附加到需要更新的记录中
    for (const record of allRecords) {
      const contractAddr = record.stakingContract.toLowerCase();
      if (contractsToUpdate.has(contractAddr)) {
        const details = detailsMap.get(contractAddr);
        if (details) {
          record.details = details;
        }
      }
    }
  } else {
    console.log(`\n没有需要更新详情的合约`);
  }

  // 合并新旧事件并附加到记录中
  let totalEventsCount = 0;
  for (const record of allRecords) {
    const contractAddr = record.stakingContract.toLowerCase();
    const existingEvents = existingEventsMap.get(contractAddr) || [];
    const contractNewEvents = newEventsMap.get(contractAddr) || [];

    // 合并事件
    const mergedEvents = [...existingEvents, ...contractNewEvents];
    // 按区块号排序
    mergedEvents.sort((a, b) => a.blockNumber - b.blockNumber);
    record.events = mergedEvents;
    totalEventsCount += mergedEvents.length;
  }

  // 统计事件数量（从所有记录中统计）
  let totalStakedEvents = 0;
  let totalWithdrawnEvents = 0;
  let totalExtendedEvents = 0;
  let totalEthWithdrawnAmount = 0;
  let totalToken1WithdrawnAmount = 0;
  let totalToken2WithdrawnAmount = 0;
  for (const record of allRecords) {
    if (record.events) {
      let withdrawnEvents = record.events.filter(e => e.type === 'Withdrawn');

      totalStakedEvents += record.events.filter(e => e.type === 'Staked').length;
      totalExtendedEvents += record.events.filter(e => e.type === 'StakeExtended').length;
      totalWithdrawnEvents += withdrawnEvents.length;

      totalEthWithdrawnAmount += withdrawnEvents.reduce((sum, e) => sum + parseFloat(e.ethAmount || '0'), 0);
      totalToken1WithdrawnAmount += withdrawnEvents.reduce((sum, e) => sum + parseFloat(e.token1Amount || '0'), 0);
      totalToken2WithdrawnAmount += withdrawnEvents.reduce((sum, e) => sum + parseFloat(e.token2Amount || '0'), 0);
    }
  }

  // 5.1 获取 Token Transfer 事件（转入/转出 Staking 合约）
  // 检查命令行参数是否要求重新获取全部 Token Transfer
  const args = process.argv.slice(2);
  const forceRefreshTransfers = args.includes('--refresh-transfers');

  if (forceRefreshTransfers) {
    console.log(`\n--refresh-transfers 参数：将重新获取全部 Token Transfer 历史数据`);
  }

  // 收集已有的 Token Transfer 事件
  const existingTokenTransfersMap = new Map<string, TokenTransfer[]>();
  let hasExistingTokenTransfers = false;

  if (!forceRefreshTransfers) {
    for (const record of existingRecords) {
      if (record.tokenTransfers && record.tokenTransfers.length > 0) {
        existingTokenTransfersMap.set(record.stakingContract.toLowerCase(), record.tokenTransfers);
        hasExistingTokenTransfers = true;
      }
    }
  }

  // 确定 Token Transfer 查询的起始区块
  // 如果没有历史 tokenTransfers 数据或强制刷新，则从 INITIAL_START_BLOCK 开始获取全部
  const tokenTransferStartBlock = hasExistingTokenTransfers
    ? eventStartBlock
    : INITIAL_START_BLOCK;

  // 获取新的 Token Transfer 事件
  let newTokenTransfers: TokenTransfer[] = [];
  const tokenAddresses = [stakingTokens.token1, stakingTokens.token2].filter(addr => addr && addr !== '0x0000000000000000000000000000000000000000');

  // 只有eco链需要获取Token Transfer事件（为了解决漏洞，统一将旧质押合约都迁移到新质押合约，质押资产通过Transfer转移）
  if (network == 'eco-prod') {
    const tokenTransferEndBlock = 3000000;
    if (tokenTransferStartBlock < tokenTransferEndBlock && tokenAddresses.length > 0) {
      console.log(hasExistingTokenTransfers
        ? `\n增量获取 Token Transfer...`
        : `\n首次获取全部 Token Transfer 历史数据...`);
      newTokenTransfers = await fetchTokenTransfers(
        provider,
        tokenTransferStartBlock,
        currentBlock,
        validContractsSet,
        STAKING_FACTORY_ADDRESS,
        tokenAddresses
      );
    }
  }

  // 将新的 Token Transfer 事件按 Staking 合约分组
  const newTokenTransfersMap = new Map<string, TokenTransfer[]>();
  for (const transfer of newTokenTransfers) {
    // 根据 transfer 类型确定关联的 Staking 合约
    const contractAddr = transfer.type === 'TransferIn'
      ? transfer.to.toLowerCase()
      : transfer.from.toLowerCase();

    if (!newTokenTransfersMap.has(contractAddr)) {
      newTokenTransfersMap.set(contractAddr, []);
    }
    newTokenTransfersMap.get(contractAddr)!.push(transfer);
  }

  // 合并新旧 Token Transfer 事件并附加到记录中
  let totalTokenTransferCount = 0;
  for (const record of allRecords) {
    const contractAddr = record.stakingContract.toLowerCase();
    const existingTransfers = existingTokenTransfersMap.get(contractAddr) || [];
    const contractNewTransfers = newTokenTransfersMap.get(contractAddr) || [];

    // 合并并去重（基于 transactionHash）
    const existingHashes = new Set(existingTransfers.map(t => t.transactionHash));
    const uniqueNewTransfers = contractNewTransfers.filter(t => !existingHashes.has(t.transactionHash));

    const mergedTransfers = [...existingTransfers, ...uniqueNewTransfers];
    // 按区块号排序
    mergedTransfers.sort((a, b) => a.blockNumber - b.blockNumber);
    record.tokenTransfers = mergedTransfers;
    totalTokenTransferCount += mergedTransfers.length;
  }

  // 5.2 关联 Staked/Withdrawn 事件中的所有 token 数量到 tokenTransfers
  console.log(`\n关联 Staked/Withdrawn 事件中的 token 数量到 tokenTransfers...`);

  // 首先，构建一个全局的交易哈希 -> 事件 映射
  // 这样可以从任何 Staking 合约的事件中获取关联的 token 数量
  const globalEventsByTxHash = new Map<string, StakingEvent>();
  for (const record of allRecords) {
    if (!record.events) continue;
    for (const event of record.events) {
      if (event.type === 'Staked' || event.type === 'Withdrawn') {
        // 如果同一交易有多个事件，优先使用 Staked 事件
        const existing = globalEventsByTxHash.get(event.transactionHash);
        if (!existing || event.type === 'Staked') {
          globalEventsByTxHash.set(event.transactionHash, event);
        }
      }
    }
  }
  console.log(`全局事件索引: ${globalEventsByTxHash.size} 个交易`);

  let relatedCount = 0;
  for (const record of allRecords) {
    if (!record.tokenTransfers) continue;

    // 为每个 tokenTransfer 关联对应的 event 数据（从全局索引中查找）
    for (const transfer of record.tokenTransfers) {
      const relatedEvent = globalEventsByTxHash.get(transfer.transactionHash);
      if (relatedEvent) {
        transfer.relatedEthAmount = relatedEvent.ethAmount;
        transfer.relatedToken1Amount = relatedEvent.token1Amount;
        transfer.relatedToken2Amount = relatedEvent.token2Amount;
        relatedCount++;
      }
    }
  }
  console.log(`已关联 ${relatedCount} 个 tokenTransfers 的完整 token 信息`);


  // 统计 Token Transfer 事件
  let totalTransferIn = 0;
  let totalTransferOut = 0;
  for (const record of allRecords) {
    if (record.tokenTransfers) {
      totalTransferIn += record.tokenTransfers.filter(t => t.type === 'TransferIn').length;
      totalTransferOut += record.tokenTransfers.filter(t => t.type === 'TransferOut').length;
    }
  }

  // 6. 计算统计数据
  // const activeStakings = allRecords.filter(r => r.details?.isActive === true);
  const activeStakings = allRecords.filter(r => {
    const ethAmount = parseFloat(r.details?.ethAmount || '0');
    const token1Amount = parseFloat(r.details?.token1Amount || '0');
    const token2Amount = parseFloat(r.details?.token2Amount || '0');
    return ethAmount !== 0 || token1Amount !== 0 || token2Amount !== 0;
  });
  const nowTimestamp = Math.floor(Date.now() / 1000);
  const expiredStakings = allRecords.filter(r =>
    r.details?.isActive === true &&
    r.details?.endTime > 0 &&
    r.details?.endTime < nowTimestamp
  );

  let totalActiveEth = activeStakings.reduce((sum, r) => sum + parseFloat(r.details?.ethAmount || '0'), 0)
  let totalActiveToken1 = activeStakings.reduce((sum, r) => sum + parseFloat(r.details?.token1Amount || '0'), 0)
  let totalActiveToken2 = activeStakings.reduce((sum, r) => sum + parseFloat(r.details?.token2Amount || '0'), 0)

  const stats = {
    totalStakingContracts: allRecords.length,
    activeStakings: activeStakings.length,
    expiredStakings: expiredStakings.length,
    // 事件统计
    totalEvents: totalEventsCount,
    newEventsCount: newEvents.length,
    stakedEvents: totalStakedEvents,
    withdrawnEvents: totalWithdrawnEvents,
    extendedEvents: totalExtendedEvents,
    // Token Transfer 统计
    totalTokenTransfers: totalTokenTransferCount,
    newTokenTransfersCount: newTokenTransfers.length,
    transferInEvents: totalTransferIn,
    transferOutEvents: totalTransferOut,
    // 当前已质押总量
    totalActiveEth: totalActiveEth,
    totalActiveToken1: totalActiveToken1,
    totalActiveToken2: totalActiveToken2,
    // 已过期质押总量
    totalExpiredEth: expiredStakings.reduce((sum, r) => sum + parseFloat(r.details?.ethAmount || '0'), 0),
    totalExpiredToken1: expiredStakings.reduce((sum, r) => sum + parseFloat(r.details?.token1Amount || '0'), 0),
    totalExpiredToken2: expiredStakings.reduce((sum, r) => sum + parseFloat(r.details?.token2Amount || '0'), 0),
    // 历史累计质押总量
    totalEth: totalActiveEth + totalEthWithdrawnAmount,
    totalToken1: totalActiveToken1 + totalToken1WithdrawnAmount,
    totalToken2: totalActiveToken2 + totalToken2WithdrawnAmount,
    firstStakingBlock: allRecords.length > 0 ? allRecords[0].blockNumber : null,
    lastStakingBlock: allRecords.length > 0 ? allRecords[allRecords.length - 1].blockNumber : null
  };

  console.log(`\n===== Staking 统计 =====`);
  console.log(`总 Staking 合约数: ${formatWithCommas(stats.totalStakingContracts, 0)}`);
  console.log(`活跃 Staking 数: ${formatWithCommas(stats.activeStakings, 0)}`);
  console.log(`已到期 Staking 数: ${formatWithCommas(stats.expiredStakings, 0)}`);
  console.log(`\n===== Staking 事件统计 =====`);
  console.log(`  总事件数: ${formatWithCommas(stats.totalEvents, 0)}`);
  console.log(`  本次新增事件: ${formatWithCommas(stats.newEventsCount, 0)}`);
  console.log(`  Staked 事件: ${formatWithCommas(stats.stakedEvents, 0)}`);
  console.log(`  Withdrawn 事件: ${formatWithCommas(stats.withdrawnEvents, 0)}`);
  console.log(`  StakeExtended 事件: ${formatWithCommas(stats.extendedEvents, 0)}`);
  console.log(`\n===== Token Transfer 统计 =====`);
  console.log(`  总 Transfer 数: ${formatWithCommas(stats.totalTokenTransfers, 0)}`);
  console.log(`  本次新增 Transfer: ${formatWithCommas(stats.newTokenTransfersCount, 0)}`);
  console.log(`  TransferIn (转入 Staking): ${formatWithCommas(stats.transferInEvents, 0)}`);
  console.log(`  TransferOut (转出 Staking): ${formatWithCommas(stats.transferOutEvents, 0)}`);
  console.log(`\n===== 当前已质押总量 =====`);
  console.log(`  Native Token: ${formatWithCommas(stats.totalActiveEth, 8)}`);
  console.log(`  Token1: ${formatWithCommas(stats.totalActiveToken1, 4)}`);
  console.log(`  Token2: ${formatWithCommas(stats.totalActiveToken2, 4)}`);
  console.log(`\n===== 已过期质押总量 =====`);
  console.log(`  Native Token: ${formatWithCommas(stats.totalExpiredEth, 8)}`);
  console.log(`  Token1: ${formatWithCommas(stats.totalExpiredToken1, 4)}`);
  console.log(`  Token2: ${formatWithCommas(stats.totalExpiredToken2, 4)}`);
  console.log(`\n===== 历史累计质押总量 =====`);
  console.log(`  Native Token: ${formatWithCommas(stats.totalEth, 8)}`);
  console.log(`  Token1: ${formatWithCommas(stats.totalToken1, 4)}`);
  console.log(`  Token2: ${formatWithCommas(stats.totalToken2, 4)}`);

  if (allRecords.length > 0) {
    // 保存到文件
    fs.writeFileSync(outputFile, JSON.stringify({
      stats,
      factoryAddress: STAKING_FACTORY_ADDRESS,
      currentBlock,
      records: allRecords
    }, null, 2));
    console.log(`\n记录已保存到 ${outputFile}`);
    console.log(`本次新增 Staking 合约: ${newRecords.length} 个`);
  }

  // 显示脚本执行总时间
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`\n===== 脚本执行完成 =====`);
  console.log(`总耗时: ${duration.toFixed(2)} 秒`);
}

main().catch(console.error);

