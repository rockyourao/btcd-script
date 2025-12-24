/**
 * 获取 LoanContract 合约的 OrderCreated 事件并读取订单详细信息
 *
 * 使用方法:
 * npx ts-node btcdOrderStats.ts                     # 获取所有订单
 * npx ts-node btcdOrderStats.ts --limit 50          # 获取最新 50 条
 * npx ts-node btcdOrderStats.ts --orderType 0       # 按订单类型过滤
 * npx ts-node btcdOrderStats.ts --skip-timestamp    # 跳过时间戳获取
 * npx ts-node btcdOrderStats.ts --fetch-details     # 获取订单详细信息
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ethers } = require('ethers');
const fs = require('fs');

import { TIMESTAMP_BATCH_SIZE } from './config';

// const network = 'eco-prod';
const network = 'pgp-prod';

// 从 network.json 加载配置
const networkConfig = require('./network.json');
const LOAN_CONTRACT_ADDRESS = networkConfig[network].loan_contractaddress;
const MULTICALL3_ADDRESS = networkConfig[network].multicall3;
const INITIAL_START_BLOCK = networkConfig[network].start_block;
const BATCH_SIZE = networkConfig[network].batch_size;
const RPC_URL = networkConfig[network].rpc_url;

// 加载合约 ABI
const loanContractAbi = require('./abi/LoanContract.json').abi;
const orderAbi = require('./abi/Order.json').abi;
const multicall3Abi = require('./abi/Multicall3.json').abi;

// OrderCreated 事件签名
// event OrderCreated(address indexed orderId, OrderType indexed orderType, uint256 collateral, address token, uint256 tokenAmount)
const ORDER_CREATED_TOPIC = ethers.utils.id('OrderCreated(address,uint8,uint256,address,uint256)');

// 订单类型枚举
enum OrderType {
  Borrow = 0,
  Lend = 1
}

// 订单状态枚举
enum OrderStatus {
  CREATED = 0,                        // 初始状态
  TAKEN = 1,                          // 已接单
  BORROWER_PROOF_SUBMITTED = 2,       // 借款人已提交BTC锁定证明（待验证）
  BORROWER_PAY_ARBITRATOR_SUBMITTED = 3, // 借款人已提交仲裁员费用支付证明
  BORROWED = 4,                       // 已借款（BTC锁定证明已验证，代币已转给借款人）
  REPAID = 5,                         // 借款人已还款（出借人未确认）
  LENDER_PROOF_SUBMITTED = 6,         // 出借人/证明服务已确认还款（ZKP证明已验证）
  LENDER_PAYMENT_CONFIRMED = 7,       // 借款人确认出借人已执行解锁脚本
  ARBITRATION_REQUESTED = 8,          // 已请求仲裁
  CLOSED = 9                          // 已关闭（最终状态）
}

// 订单状态名称映射
const OrderStatusNames: { [key: number]: string } = {
  0: 'CREATED',
  1: 'TAKEN',
  2: 'BORROWER_PROOF_SUBMITTED',
  3: 'BORROWER_PAY_ARBITRATOR_SUBMITTED',
  4: 'BORROWED',
  5: 'REPAID',
  6: 'LENDER_PROOF_SUBMITTED',
  7: 'LENDER_PAYMENT_CONFIRMED',
  8: 'ARBITRATION_REQUESTED',
  9: 'CLOSED'
};

interface OrderRecord {
  orderId: string;         // 订单地址
  orderType: number;       // 订单类型 (0: Borrow, 1: Lend)
  orderTypeName: string;   // 订单类型名称
  collateral: string;      // 抵押品数量
  collateralRaw: string;   // 抵押品原始值
  token: string;           // 代币地址
  tokenAmount: string;     // 代币数量
  tokenAmountRaw: string;  // 代币数量原始值
  blockNumber: number;
  timestamp: number;
  timestampStr: string;
  transactionHash: string;
  // 订单详细信息（通过 multicall 获取）
  details?: OrderDetails;
}

interface OrderDetails {
  status: number;               // 订单状态
  statusName: string;           // 订单状态名称
  borrower: string;
  borrowerBtcAddress: string;
  lender: string;
  lenderBtcAddress: string;
  createTime: number;
  createTimeStr: string;
  takenTime: number;
  takenTimeStr: string;
  borrowedTime: number;
  borrowedTimeStr: string;
  borrowerRepaidTime: number;
  borrowerRepaidTimeStr: string;
  deadLinesData: {
    orderDeadLine: number;
    submitPledgeProofDeadLine: number;
    borrowDeadLine: number;
    repayDeadLine: number;
    submitRegularProofDeadLine: number;
  };
  realBtcAmount: string;        // toLenderBtcTx.amount (BTC)
  realBtcAmountRaw: string;     // 原始值 (satoshi)
  useDiscount: boolean;         // collateral == toLenderBtcTx.amount
}

// BTC 精度 (8 位小数)
const BTC_DECIMALS = 8;

/**
 * 将 satoshi 转换为 BTC
 */
function formatBtc(satoshi: any): string {
  if (!satoshi) return '0';
  const satoshiStr = satoshi.toString();
  if (satoshiStr === '0') return '0';

  // 使用 BigNumber 进行精确计算
  const bn = ethers.BigNumber.from(satoshi);
  const divisor = ethers.BigNumber.from(10).pow(BTC_DECIMALS);
  const intPart = bn.div(divisor);
  const fracPart = bn.mod(divisor);

  if (fracPart.isZero()) {
    return intPart.toString();
  }

  const fracStr = fracPart.toString().padStart(BTC_DECIMALS, '0').replace(/0+$/, '');
  return `${intPart.toString()}.${fracStr}`;
}

interface QueryOptions {
  orderType?: number;
  limit?: number;
  beforeBlock?: number;
  fetchAll?: boolean;
  skipTimestamp?: boolean;
  fetchDetails?: boolean;
}

// Multicall 批次大小
const MULTICALL_BATCH_SIZE = 200;

/**
 * 将 topic 转换为地址格式
 */
function topicToAddress(topic: string): string {
  return '0x' + topic.slice(26).toLowerCase();
}

/**
 * 获取区块时间戳
 */
async function getBlockTimestamps(blockNumbers: number[]): Promise<Map<number, number>> {
  const blockTimestamps: Map<number, number> = new Map();

  for (let i = 0; i < blockNumbers.length; i += TIMESTAMP_BATCH_SIZE) {
    const batch = blockNumbers.slice(i, i + TIMESTAMP_BATCH_SIZE);

    try {
      const batchRequest = batch.map((blockNum: number, idx: number) => ({
        jsonrpc: '2.0',
        id: idx,
        method: 'eth_getBlockByNumber',
        params: ['0x' + blockNum.toString(16), false]
      }));

      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchRequest)
      });

      const results = await response.json() as any[];

      for (const result of results) {
        if (result.result && result.result.timestamp) {
          const blockNum = parseInt(result.result.number, 16);
          const timestamp = parseInt(result.result.timestamp, 16);
          blockTimestamps.set(blockNum, timestamp);
        }
      }
    } catch (error) {
      console.error(`获取区块时间戳失败:`, error);
    }
  }

  return blockTimestamps;
}

/**
 * 将时间戳转换为可读字符串
 */
function timestampToStr(timestamp: number): string {
  if (!timestamp || timestamp === 0) return '';
  return new Date(timestamp * 1000).toISOString();
}

/**
 * 获取指定时间戳所在的时间单位开始时间戳
 * @param {number} [timestamp=Date.now()] - 时间戳（毫秒）
 * @param {string} [unit='day'] - 时间单位: 'day' | 'week' | 'month'
 * @returns {number} 时间戳（秒）
 */
function getUnitStartTimestamp(timestamp: number, unit: 'day' | 'week' | 'month' = 'day'): number {
  const date = new Date(timestamp * 1000);

  // 重置时分秒为00:00:00
  date.setHours(0, 0, 0, 0);

  switch(unit.toLowerCase()) {
      case 'week':
          const day = date.getDay();
          const diff = date.getDate() - day + (day === 0 ? -6 : 1); // 计算周一的日期
          date.setDate(diff);
          break;

      case 'month':
          date.setDate(1); // 设置为当月1号
          break;

      // 'day' 是默认情况，已经处理了
  }

  return Math.floor(date.getTime() / 1000); // 返回秒级时间戳
}


/**
 * 格式化时间戳为可读的日期字符串
 * @param timestamp 时间戳（秒）
 * @param unit 时间单位: 'day' | 'week' | 'month'，默认为'week'
 * @returns 格式化后的日期字符串
 */
function formatTimestampDisplay(timestamp: number, unit: 'day' | 'week' | 'month' = 'week'): string {
  const dt = new Date(timestamp * 1000);

  switch(unit) {
    case 'day':
      return dt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });

    case 'week':
      return `Week of ${dt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      })}`;

    case 'month':
      return dt.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long'
      });

    default:
      return dt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });
  }
}

/**
 * 使用 Multicall3 批量获取订单详细信息
 */
async function fetchOrderDetailsWithMulticall(
  provider: any,
  orderIds: string[]
): Promise<Map<string, OrderDetails>> {
  const orderDetailsMap = new Map<string, OrderDetails>();
  const orderInterface = new ethers.utils.Interface(orderAbi);
  const multicall3 = new ethers.Contract(MULTICALL3_ADDRESS, multicall3Abi, provider);

  // 每个订单需要调用的函数
  const functionNames = [
    'status',
    'borrower',
    'borrowerBtcAddress',
    'lender',
    'lenderBtcAddress', // order BTC Address
    'createTime',
    'takenTime',
    'borrowedTime',
    'borrowerRepaidTime',
    'deadLinesData',
    'toLenderBtcTx'
  ];

  console.log(`\n使用 Multicall3 获取 ${orderIds.length} 个订单的详细信息...`);
  console.log(`Multicall3 地址: ${MULTICALL3_ADDRESS}`);
  console.log(`每批次处理: ${MULTICALL_BATCH_SIZE} 个订单`);

  // 分批处理订单
  for (let i = 0; i < orderIds.length; i += MULTICALL_BATCH_SIZE) {
    const batchOrderIds = orderIds.slice(i, i + MULTICALL_BATCH_SIZE);
    const calls: any[] = [];

    // 为每个订单构建调用数据
    for (const orderId of batchOrderIds) {
      for (const funcName of functionNames) {
        const callData = orderInterface.encodeFunctionData(funcName);
        calls.push({
          target: orderId,
          allowFailure: true,
          callData
        });
      }
    }

    try {
      const results = await multicall3.aggregate3(calls);

      // 解析结果
      let resultIdx = 0;
      for (const orderId of batchOrderIds) {
        try {
          const statusResult = results[resultIdx++];
          const borrowerResult = results[resultIdx++];
          const borrowerBtcAddressResult = results[resultIdx++];
          const lenderResult = results[resultIdx++];
          const lenderBtcAddressResult = results[resultIdx++];
          const createTimeResult = results[resultIdx++];
          const takenTimeResult = results[resultIdx++];
          const borrowedTimeResult = results[resultIdx++];
          const borrowerRepaidTimeResult = results[resultIdx++];
          const deadLinesDataResult = results[resultIdx++];
          const toLenderBtcTxResult = results[resultIdx++];

          // 解码各个字段
          const status = statusResult.success
            ? orderInterface.decodeFunctionResult('status', statusResult.returnData)[0]
            : 0;
          const borrower = borrowerResult.success
            ? orderInterface.decodeFunctionResult('borrower', borrowerResult.returnData)[0]
            : '';
          const borrowerBtcAddress = borrowerBtcAddressResult.success
            ? orderInterface.decodeFunctionResult('borrowerBtcAddress', borrowerBtcAddressResult.returnData)[0]
            : '';
          const lender = lenderResult.success
            ? orderInterface.decodeFunctionResult('lender', lenderResult.returnData)[0]
            : '';
          const lenderBtcAddress = lenderBtcAddressResult.success
            ? orderInterface.decodeFunctionResult('lenderBtcAddress', lenderBtcAddressResult.returnData)[0]
            : '';
          const createTime = createTimeResult.success
            ? orderInterface.decodeFunctionResult('createTime', createTimeResult.returnData)[0].toNumber()
            : 0;
          const takenTime = takenTimeResult.success
            ? orderInterface.decodeFunctionResult('takenTime', takenTimeResult.returnData)[0].toNumber()
            : 0;
          const borrowedTime = borrowedTimeResult.success
            ? orderInterface.decodeFunctionResult('borrowedTime', borrowedTimeResult.returnData)[0].toNumber()
            : 0;
          const borrowerRepaidTime = borrowerRepaidTimeResult.success
            ? orderInterface.decodeFunctionResult('borrowerRepaidTime', borrowerRepaidTimeResult.returnData)[0].toNumber()
            : 0;

          let deadLinesData = {
            orderDeadLine: 0,
            submitPledgeProofDeadLine: 0,
            borrowDeadLine: 0,
            repayDeadLine: 0,
            submitRegularProofDeadLine: 0
          };

          if (deadLinesDataResult.success) {
            const decoded = orderInterface.decodeFunctionResult('deadLinesData', deadLinesDataResult.returnData);
            deadLinesData = {
              orderDeadLine: decoded.orderDeadLine.toNumber(),
              submitPledgeProofDeadLine: decoded.submitPledgeProofDeadLine.toNumber(),
              borrowDeadLine: decoded.borrowDeadLine.toNumber(),
              repayDeadLine: decoded.repayDeadLine.toNumber(),
              submitRegularProofDeadLine: decoded.submitRegularProofDeadLine.toNumber()
            };
          }

          // 解码 toLenderBtcTx 获取 realBtcAmount
          let realBtcAmountRaw = '0';
          let realBtcAmount = '0';
          if (toLenderBtcTxResult.success) {
            try {
              const decoded = orderInterface.decodeFunctionResult('toLenderBtcTx', toLenderBtcTxResult.returnData);
              realBtcAmountRaw = decoded.amount.toString();
              realBtcAmount = formatBtc(decoded.amount);
            } catch {
              // 解码失败，保持默认值
            }
          }

          orderDetailsMap.set(orderId.toLowerCase(), {
            status,
            statusName: OrderStatusNames[status] || 'Unknown',
            borrower,
            borrowerBtcAddress,
            lender,
            lenderBtcAddress,
            createTime,
            createTimeStr: timestampToStr(createTime),
            takenTime,
            takenTimeStr: timestampToStr(takenTime),
            borrowedTime,
            borrowedTimeStr: timestampToStr(borrowedTime),
            borrowerRepaidTime,
            borrowerRepaidTimeStr: timestampToStr(borrowerRepaidTime),
            deadLinesData,
            realBtcAmount,
            realBtcAmountRaw,
            useDiscount: false // 将在附加到记录时计算
          });
        } catch (decodeError) {
          console.error(`解码订单 ${orderId} 详情失败:`, decodeError);
        }
      }

      const progress = Math.min(i + MULTICALL_BATCH_SIZE, orderIds.length);
      console.log(`已处理: ${progress}/${orderIds.length} (${((progress / orderIds.length) * 100).toFixed(1)}%)`);
    } catch (error) {
      console.error(`Multicall 批次 ${i} - ${i + MULTICALL_BATCH_SIZE} 失败:`, error);
    }
  }

  console.log(`成功获取 ${orderDetailsMap.size} 个订单的详细信息`);
  return orderDetailsMap;
}

/**
 * 解析 OrderCreated 事件日志
 */
function parseOrderLogs(logs: any[], blockTimestamps: Map<number, number>): OrderRecord[] {
  const iface = new ethers.utils.Interface(loanContractAbi);

  return logs.map((log: any) => {
    const timestamp = blockTimestamps.get(log.blockNumber) || 0;
    const timestampStr = timestamp ? new Date(timestamp * 1000).toISOString() : '';

    // indexed 参数在 topics 中
    const orderId = topicToAddress(log.topics[1]);
    const orderType = parseInt(log.topics[2], 16);

    // 非 indexed 参数在 data 中解码
    const decoded = iface.decodeEventLog('OrderCreated', log.data, log.topics);

    return {
      orderId,
      orderType,
      orderTypeName: orderType === OrderType.Borrow ? 'Borrow' : 'Lend',
      collateral: formatBtc(decoded.collateral),  // BTC 使用 8 位小数
      collateralRaw: decoded.collateral.toString(),
      token: decoded.token,
      tokenAmount: ethers.utils.formatEther(decoded.tokenAmount),
      tokenAmountRaw: decoded.tokenAmount.toString(),
      blockNumber: log.blockNumber,
      timestamp,
      timestampStr,
      transactionHash: log.transactionHash
    };
  });
}

/**
 * 构建 topics 过滤数组
 */
function buildTopics(orderType?: number): (string | null)[] {
  const topics: (string | null)[] = [ORDER_CREATED_TOPIC];

  // orderId - 不过滤
  topics.push(null);

  // orderType - 可选过滤
  if (orderType !== undefined) {
    topics.push(ethers.utils.hexZeroPad(ethers.utils.hexlify(orderType), 32));
  }

  return topics;
}

/**
 * 获取所有 OrderCreated 事件
 */
async function getOrderCreatedLogs(
  provider: any,
  currentBlock: number,
  options: QueryOptions
): Promise<{ records: OrderRecord[]; stats: any }> {
  const { orderType, limit, beforeBlock, fetchAll = true, skipTimestamp = true, fetchDetails = false } = options;

  const endBlock = currentBlock;
  const startBlock = beforeBlock ? beforeBlock : INITIAL_START_BLOCK;
  const targetCount = fetchAll ? Infinity : (limit || Infinity);

  console.log(`\n合约地址: ${LOAN_CONTRACT_ADDRESS}`);
  console.log(`事件签名: ${ORDER_CREATED_TOPIC}`);
  console.log(`从区块 ${startBlock} 到 ${endBlock} 搜索...`);

  if (orderType !== undefined) {
    console.log(`过滤订单类型: ${orderType} (${orderType === 0 ? 'Borrow' : 'Lend'})`);
  }

  const allLogs: any[] = [];
  const topics = buildTopics(orderType);

  // 从起始区块向前搜索
  for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += BATCH_SIZE) {
    const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, endBlock);

    try {
      const logs = await provider.getLogs({
        address: LOAN_CONTRACT_ADDRESS,
        topics: topics,
        fromBlock,
        toBlock
      });

      if (logs.length > 0) {
        allLogs.push(...logs);
        console.log(`区块 ${fromBlock} - ${toBlock}: 找到 ${logs.length} 条 (累计: ${allLogs.length})`);
      }

      // 检查是否已找到足够数量
      if (!fetchAll && allLogs.length >= targetCount) {
        console.log(`已找到 ${allLogs.length} 条记录，达到目标数量，停止搜索`);
        break;
      }
    } catch (error) {
      console.error(`查询区块 ${fromBlock} - ${toBlock} 失败:`, error);
      // 尝试更小的批次
      const SMALLER_BATCH = 10000;
      for (let subFrom = fromBlock; subFrom <= toBlock; subFrom += SMALLER_BATCH) {
        const subTo = Math.min(subFrom + SMALLER_BATCH - 1, toBlock);
        try {
          const logs = await provider.getLogs({
            address: LOAN_CONTRACT_ADDRESS,
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

  console.log(`\n总共获取到 ${allLogs.length} 条 OrderCreated 事件日志`);

  if (allLogs.length === 0) {
    return { records: [], stats: {} };
  }

  // 按区块号升序排序
  allLogs.sort((a: any, b: any) => a.blockNumber - b.blockNumber);

  // 获取区块时间戳（可跳过）
  let blockTimestamps: Map<number, number> = new Map();
  if (!skipTimestamp) {
    const uniqueBlockNumbers = [...new Set(allLogs.map((log: any) => log.blockNumber))] as number[];
    console.log(`需要获取 ${uniqueBlockNumbers.length} 个区块的时间戳...`);
    blockTimestamps = await getBlockTimestamps(uniqueBlockNumbers);
  } else {
    console.log(`跳过时间戳获取...`);
  }

  let records = parseOrderLogs(allLogs, blockTimestamps);

  // 获取订单详细信息（如果需要）
  if (fetchDetails) {
    const orderIds = records.map(r => r.orderId);
    const detailsMap = await fetchOrderDetailsWithMulticall(provider, orderIds);

    // 将详情附加到记录中，并计算 useDiscount
    records = records.map(record => {
      const details = detailsMap.get(record.orderId.toLowerCase());
      if (details) {
        // 比较 collateralRaw 和 realBtcAmountRaw，相等则 useDiscount 为 true
        details.useDiscount = details.realBtcAmountRaw === record.collateralRaw;
      }
      return {
        ...record,
        details
      };
    });
  }

  // 统计数据
  const stats = {
    totalOrders: records.length,
    borrowOrders: records.filter(r => r.orderType === OrderType.Borrow).length,
    lendOrders: records.filter(r => r.orderType === OrderType.Lend).length,
    totalCollateral: records.reduce((sum, r) => sum + parseFloat(r.collateral), 0),
    totalTokenAmount: records.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    uniqueTokens: [...new Set(records.map(r => r.token))],
    firstOrderBlock: records.length > 0 ? records[0].blockNumber : null,
    lastOrderBlock: records.length > 0 ? records[records.length - 1].blockNumber : null,
    firstOrderTime: records.length > 0 ? records[0].timestampStr : null,
    lastOrderTime: records.length > 0 ? records[records.length - 1].timestampStr : null
  };

  return { records, stats };
}

async function main() {
  const args = process.argv.slice(2);

  let orderType: number | undefined;
  let limit: number | undefined;
  let beforeBlock: number | undefined;
  let fetchAll = true;
  let skipTimestamp = true;
  let fetchDetails = false;

  // 解析参数
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--orderType' && args[i + 1]) {
      orderType = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      fetchAll = false;
      i++;
    } else if (args[i] === '--before' && args[i + 1]) {
      beforeBlock = parseInt(args[i + 1], 10);
      i++;
    // } else if (args[i] === '--skip-timestamp') {
    //   skipTimestamp = true;
    } else if (args[i] === '--fetch-details') {
      fetchDetails = true;
    }
  }

  const startTime = Date.now();
  console.log('\n===== 获取 OrderCreated 事件 =====');

  const provider = new (ethers as any).providers.JsonRpcProvider(RPC_URL);
  const outputFile = `data/${network}/btcd_order_stats.json`;

  const currentBlock: number = await provider.getBlockNumber();
  console.log(`当前区块高度: ${currentBlock}`);

  // 1. 从已有数据文件中读取数据
  let existingRecords: OrderRecord[] = [];
  let savedCurrentBlock = 0;

  try {
    if (fs.existsSync(outputFile)) {
      console.log(`\n读取已有数据文件: ${outputFile}`);
      const savedData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      if (savedData.records && Array.isArray(savedData.records)) {
        existingRecords = savedData.records;
        console.log(`已读取 ${existingRecords.length} 条现有订单记录`);
      }
      if (savedData.currentBlock) {
        savedCurrentBlock = savedData.currentBlock;
        console.log(`上次同步的区块高度: ${savedCurrentBlock}`);
      }
    }
  } catch (error) {
    console.error(`读取 ${outputFile} 失败:`, error);
  }

  // 如果 beforeBlock 未定义，使用保存的 currentBlock
  if (beforeBlock === undefined && savedCurrentBlock > 0) {
    beforeBlock = savedCurrentBlock;
  }

  // 2. 获取新创建的订单
  console.log(`\n获取从区块 ${beforeBlock ? beforeBlock + 1 : INITIAL_START_BLOCK} 到 ${currentBlock} 的新订单...`);
  const { records: newRecords } = await getOrderCreatedLogs(provider, currentBlock, {
    orderType,
    limit,
    beforeBlock,
    fetchAll,
    skipTimestamp,
    fetchDetails: true  // 新订单始终获取详情
  });

  console.log(`\n找到 ${newRecords.length} 条新订单`);

  // 3. 找出所有 status 不是 Closed(6) 和 Cancelled(7) 的订单，需要重新获取详情
  const nonClosedOrders = existingRecords.filter(r => {
    const status = r.details?.status;
    return status !== OrderStatus.CLOSED;
  });

  console.log(`\n需要更新状态的订单 (非 Closed/Cancelled): ${nonClosedOrders.length} 条`);

  // 获取这些订单的最新详情
  let updatedDetailsMap = new Map<string, OrderDetails>();
  if (nonClosedOrders.length > 0) {
    const orderIdsToUpdate = nonClosedOrders.map(r => r.orderId);
    updatedDetailsMap = await fetchOrderDetailsWithMulticall(provider, orderIdsToUpdate);
  }

  // 4. 合并数据：更新现有记录的详情
  const existingRecordsMap = new Map<string, OrderRecord>();
  for (const record of existingRecords) {
    const orderId = record.orderId.toLowerCase();
    // 如果有更新的详情，应用它
    if (updatedDetailsMap.has(orderId)) {
      const newDetails = updatedDetailsMap.get(orderId)!;
      // 计算 useDiscount
      newDetails.useDiscount = newDetails.realBtcAmountRaw === record.collateralRaw;
      record.details = newDetails;
    }
    existingRecordsMap.set(orderId, record);
  }

  // 添加新记录（新记录已经有详情了）
  for (const newRecord of newRecords) {
    const orderId = newRecord.orderId.toLowerCase();
    if (!existingRecordsMap.has(orderId)) {
      existingRecordsMap.set(orderId, newRecord);
    }
  }

  // 转换为数组并按区块号排序
  const allRecords = Array.from(existingRecordsMap.values());
  allRecords.sort((a, b) => a.blockNumber - b.blockNumber);

  // 当前时间戳（用于计算到期未还款）
  const nowTimestamp = Math.floor(Date.now() / 1000);

  // 筛选当前已借出的订单（BORROWED 状态）
  const borrowedOrders = allRecords.filter(r => r.details?.status === OrderStatus.BORROWED);

  // 筛选已清算的订单：status 为 CLOSED，有 borrowedTime 但没有 borrowerRepaidTime
  // TODO: 需要优化，因为有些订单请求了仲裁，没有清算 （可以通过ArbitrationRequested事件？ 或者通过合约拿borrowerUnlockSignature？）
  const liquidatedOrders = allRecords.filter(r =>
    r.details?.status === OrderStatus.CLOSED &&
    r.details?.borrowedTime > 0 &&
    !r.details?.borrowerRepaidTime
  );

  // 筛选到期未还款的订单：status 为 BORROWED，repayDeadLine 已到，但 borrowerRepaidTime 还是 0
  const overdueOrders = allRecords.filter(r =>
    r.details?.status === OrderStatus.BORROWED &&
    r.details?.deadLinesData?.repayDeadLine > 0 &&
    r.details?.deadLinesData?.repayDeadLine < nowTimestamp &&
    !r.details?.borrowerRepaidTime
  );


  // 计算统计数据
  const validOrdersList = allRecords.filter(r => r.details?.borrowedTime > 0);
  const discountOrdersList = validOrdersList.filter(r => r.details?.useDiscount === true);

  const stats = {
    totalOrders: allRecords.length,
    // 有效订单总数（borrowedTime > 0）
    validOrders: validOrdersList.length,
    // 使用 discount 的订单数（borrowedTime > 0 且 useDiscount = true）
    discountOrders: discountOrdersList.length,
    borrowOrders: allRecords.filter(r => r.orderType === OrderType.Borrow).length,
    lendOrders: allRecords.filter(r => r.orderType === OrderType.Lend).length,
    // 只统计 borrowedTime > 0 的订单（实际发生借款的订单）
    totalCollateral: allRecords.filter(r => r.details?.borrowedTime > 0).reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
    totalTokenAmount: allRecords.filter(r => r.details?.borrowedTime > 0).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    // 当前活跃的统计（status 不是 CLOSED 的订单）
    activeTokenAmount: allRecords.filter(r => r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    // 当前订单铸造的BTCD总量 = 当前活跃代币数量 + 已清算订单的代币数量
    currentMintedBTCD: allRecords.filter(r => r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0) +
      liquidatedOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    uniqueTokens: [...new Set(allRecords.map(r => r.token))],
    firstOrderBlock: allRecords.length > 0 ? allRecords[0].blockNumber : null,
    lastOrderBlock: allRecords.length > 0 ? allRecords[allRecords.length - 1].blockNumber : null,
    firstOrderTime: allRecords.length > 0 ? allRecords[0].timestampStr : null,
    lastOrderTime: allRecords.length > 0 ? allRecords[allRecords.length - 1].timestampStr : null,
    // 当前已借出统计
    currentBorrowed: {
      count: borrowedOrders.length,
      collateral: borrowedOrders.reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
      tokenAmount: borrowedOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0)
    },
    // 已清算订单统计
    liquidatedStats: {
      count: liquidatedOrders.length,
      collateral: liquidatedOrders.reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
      tokenAmount: liquidatedOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0)
    },
    // 到期未还款订单统计
    overdueStats: {
      count: overdueOrders.length,
      collateral: overdueOrders.reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
      tokenAmount: overdueOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0)
    },
    // 按状态统计
    statusStats: {
      created: allRecords.filter(r => r.details?.status === OrderStatus.CREATED).length,
      taken: allRecords.filter(r => r.details?.status === OrderStatus.TAKEN).length,
      borrowerProofSubmitted: allRecords.filter(r => r.details?.status === OrderStatus.BORROWER_PROOF_SUBMITTED).length,
      borrowerPayArbitratorSubmitted: allRecords.filter(r => r.details?.status === OrderStatus.BORROWER_PAY_ARBITRATOR_SUBMITTED).length,
      borrowed: allRecords.filter(r => r.details?.status === OrderStatus.BORROWED).length,
      repaid: allRecords.filter(r => r.details?.status === OrderStatus.REPAID).length,
      lenderProofSubmitted: allRecords.filter(r => r.details?.status === OrderStatus.LENDER_PROOF_SUBMITTED).length,
      lenderPaymentConfirmed: allRecords.filter(r => r.details?.status === OrderStatus.LENDER_PAYMENT_CONFIRMED).length,
      arbitrationRequested: allRecords.filter(r => r.details?.status === OrderStatus.ARBITRATION_REQUESTED).length,
      closed: allRecords.filter(r => r.details?.status === OrderStatus.CLOSED).length,
      liquidated: liquidatedOrders.length
    }
  };

  console.log(`\n===== 订单统计 =====`);
  console.log(`总订单数: ${stats.totalOrders}`);
  const validOrdersPercent = stats.totalOrders > 0 ? ((stats.validOrders / stats.totalOrders) * 100).toFixed(2) : '0.00';
  console.log(`有效订单数: ${stats.validOrders} (${validOrdersPercent}%)`);
  const discountOrdersPercent = stats.validOrders > 0 ? ((stats.discountOrders / stats.validOrders) * 100).toFixed(2) : '0.00';
  console.log(`使用Discount订单数: ${stats.discountOrders} (${discountOrdersPercent}%)`);
  // console.log(`借款订单 (Borrow): ${stats.borrowOrders}`);
  // console.log(`出借订单 (Lend): ${stats.lendOrders}`);
  console.log(`累计总抵押品: ${stats.totalCollateral.toFixed(8)} BTC`);
  console.log(`累计总代币数量: ${stats.totalTokenAmount.toFixed(4)}`);
  console.log(`当前活跃代币数量: ${stats.activeTokenAmount.toFixed(4)}`);
  console.log(`当前订单铸造BTCD总量: ${stats.currentMintedBTCD.toFixed(4)}`);


  if (stats.firstOrderTime) {
    console.log(`\n时间范围:`);
    console.log(`  首个订单: ${stats.firstOrderTime} (区块 ${stats.firstOrderBlock})`);
    console.log(`  最新订单: ${stats.lastOrderTime} (区块 ${stats.lastOrderBlock})`);
  }

  // 显示当前已借出统计
  console.log(`\n===== 当前已借出统计 =====`);
  console.log(`  订单数: ${stats.currentBorrowed.count}`);
  console.log(`  抵押品: ${stats.currentBorrowed.collateral.toFixed(8)} BTC`);
  console.log(`  代币数量: ${stats.currentBorrowed.tokenAmount.toFixed(4)}`);

  // 显示已清算订单统计
  console.log(`\n===== 已清算订单统计 =====`);
  console.log(`  订单数: ${stats.liquidatedStats.count}`);
  console.log(`  抵押品: ${stats.liquidatedStats.collateral.toFixed(8)} BTC`);
  console.log(`  代币数量: ${stats.liquidatedStats.tokenAmount.toFixed(4)}`);

  // 显示到期未还款订单统计
  console.log(`\n===== 到期未还款订单统计 =====`);
  console.log(`  订单数: ${stats.overdueStats.count}`);
  console.log(`  抵押品: ${stats.overdueStats.collateral.toFixed(8)} BTC`);
  console.log(`  代币数量: ${stats.overdueStats.tokenAmount.toFixed(4)}`);

  // 显示状态统计
  console.log(`\n===== 订单状态分布 =====`);
  console.log(`  CREATED (已创建): ${stats.statusStats.created}`);
  console.log(`  TAKEN (已接单): ${stats.statusStats.taken}`);
  console.log(`  BORROWER_PROOF_SUBMITTED (借款人已提交BTC锁定证明): ${stats.statusStats.borrowerProofSubmitted}`);
  console.log(`  BORROWER_PAY_ARBITRATOR_SUBMITTED (借款人已提交仲裁员费用证明): ${stats.statusStats.borrowerPayArbitratorSubmitted}`);
  console.log(`  BORROWED (已借款): ${stats.statusStats.borrowed}`);
  console.log(`  REPAID (已还款): ${stats.statusStats.repaid}`);
  console.log(`  LENDER_PROOF_SUBMITTED (出借人已提交还款证明): ${stats.statusStats.lenderProofSubmitted}`);
  console.log(`  LENDER_PAYMENT_CONFIRMED (出借人付款已确认): ${stats.statusStats.lenderPaymentConfirmed}`);
  console.log(`  ARBITRATION_REQUESTED (已请求仲裁): ${stats.statusStats.arbitrationRequested}`);
  console.log(`  CLOSED (已关闭): ${stats.statusStats.closed}`);
  console.log(`  LIQUIDATED (已清算): ${stats.statusStats.liquidated}`);

  if (allRecords.length > 0) {
    // 显示最新的几条记录
    // console.log(`\n===== 最新订单记录 (最新 5 条) =====`);
    // const latestRecords = allRecords.slice(-5).reverse();
    // for (const r of latestRecords) {
    //   console.log(`\n${r.timestampStr} (区块 ${r.blockNumber})`);
    //   console.log(`  订单ID: ${r.orderId}`);
    //   console.log(`  类型: ${r.orderTypeName}`);
    //   console.log(`  抵押品: ${r.collateral} BTC`);
    //   console.log(`  代币: ${r.token}`);
    //   console.log(`  代币数量: ${r.tokenAmount}`);
    //   console.log(`  交易: https://eco.elastos.io/tx/${r.transactionHash}`);

    //   // 显示订单详情（如果有）
    //   if (r.details) {
    //     console.log(`  --- 订单详情 ---`);
    //     console.log(`  状态: ${r.details.statusName} (${r.details.status})`);
    //     console.log(`  借款人: ${r.details.borrower || '无'}`);
    //     console.log(`  借款人BTC地址: ${r.details.borrowerBtcAddress || '无'}`);
    //     console.log(`  出借人: ${r.details.lender || '无'}`);
    //     console.log(`  出借人BTC地址: ${r.details.lenderBtcAddress || '无'}`);
    //     console.log(`  创建时间: ${r.details.createTimeStr || '无'}`);
    //     console.log(`  接单时间: ${r.details.takenTimeStr || '无'}`);
    //     console.log(`  借款时间: ${r.details.borrowedTimeStr || '无'}`);
    //     console.log(`  还款时间: ${r.details.borrowerRepaidTimeStr || '无'}`);
    //     console.log(`  实际BTC金额: ${r.details.realBtcAmount || '0'} BTC`);
    //     console.log(`  使用折扣: ${r.details.useDiscount ? '是' : '否'}`);
    //   }
    // }

    // if (allRecords.length > 5) {
    //   console.log(`\n... 还有 ${allRecords.length - 5} 条记录`);
    // }

    // 保存到文件
    fs.writeFileSync(outputFile, JSON.stringify({
      stats,
      contractAddress: LOAN_CONTRACT_ADDRESS,
      currentBlock,
      fetchedDetails: true,
      records: allRecords,
      // liquidatedOrders: liquidatedOrders,
      // overdueOrders: overdueOrders
    }, null, 2));
    console.log(`\n记录已保存到 ${outputFile}`);
    console.log(`本次新增订单: ${newRecords.length} 条`);
    console.log(`本次更新状态: ${updatedDetailsMap.size} 条`);
  }

  // 显示脚本执行总时间
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`\n===== 脚本执行完成 =====`);
  console.log(`总耗时: ${duration.toFixed(2)} 秒`);
}

main().catch(console.error);

