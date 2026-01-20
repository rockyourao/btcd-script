/**
 * 获取 LoanContract 合约的 OrderCreated 事件并读取订单详细信息
 *
 * 使用方法:
 * npx ts-node btcdOrderStats.ts                     # 获取所有订单 (默认 eco-prod)
 * npx ts-node btcdOrderStats.ts --network pgp-prod  # 指定网络
 * npx ts-node btcdOrderStats.ts --limit 50          # 获取最新 50 条
 * npx ts-node btcdOrderStats.ts --orderType 0       # 按订单类型过滤
 * npx ts-node btcdOrderStats.ts --skip-timestamp    # 跳过时间戳获取
 * npx ts-node btcdOrderStats.ts --fetch-details     # 获取订单详细信息
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const { ethers } = require('ethers');
const fs = require('fs');

import { formatBtc, formatTimestampDisplay, formatWithCommas, getBlockTimestamps, getUnitStartTimestamp, timestampToStr, topicToAddress } from './util';

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
  // console.log(`Multicall3 地址: ${MULTICALL3_ADDRESS}`);
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
): Promise<{ records: OrderRecord[] }> {
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
    return { records: [] };
  }

  // 按区块号升序排序
  allLogs.sort((a: any, b: any) => a.blockNumber - b.blockNumber);

  // 获取区块时间戳（可跳过）
  let blockTimestamps: Map<number, number> = new Map();
  if (!skipTimestamp) {
    const uniqueBlockNumbers = [...new Set(allLogs.map((log: any) => log.blockNumber))] as number[];
    console.log(`需要获取 ${uniqueBlockNumbers.length} 个区块的时间戳...`);
    blockTimestamps = await getBlockTimestamps(uniqueBlockNumbers, RPC_URL);
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

  return { records };
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
    if (args[i] === '--network' && args[i + 1]) {
      // 已在顶层处理，跳过
      i++;
    } else if (args[i] === '--orderType' && args[i + 1]) {
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
  console.log(`\n===== 获取 OrderCreated 事件 [网络: ${network}] =====`);

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
    totalCollateralDiscount: allRecords.filter(r => r.details?.borrowedTime > 0).reduce((sum, r) => sum + parseFloat(r.collateral), 0),
    totalTokenAmount: allRecords.filter(r => r.details?.borrowedTime > 0).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    // 当前活跃的统计（status 不是 CLOSED 的订单）
    activeTokenAmount: allRecords.filter(r => r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    // 当前订单铸造的BTCD总量 = 当前活跃代币数量 + 已清算订单的代币数量
    currentMintedBTCD: allRecords.filter(r => r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0) +
      liquidatedOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    // 当前锁定在订单中的BTCD总量 = 还未借出和已还款（未关闭）的订单的代币数量
    lockedInOrdersBTCD: allRecords.filter(r => r.details?.status !== OrderStatus.BORROWED && r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    uniqueTokens: [...new Set(allRecords.map(r => r.token))],
    firstOrderBlock: allRecords.length > 0 ? allRecords[0].blockNumber : null,
    lastOrderBlock: allRecords.length > 0 ? allRecords[allRecords.length - 1].blockNumber : null,
    firstOrderTime: allRecords.length > 0 ? allRecords[0].timestampStr : null,
    lastOrderTime: allRecords.length > 0 ? allRecords[allRecords.length - 1].timestampStr : null,
    // 当前已借出统计
    currentBorrowed: {
      count: borrowedOrders.length,
      collateral: borrowedOrders.reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
      collateralDiscount: borrowedOrders.reduce((sum, r) => sum + parseFloat(r.collateral), 0),
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

  // 按天统计借出订单数据（用于生成趋势图）
  const dailyBorrowedStats: Map<number, { count: number; totalRealBtc: number; totalTokenAmount: number }> = new Map();
  const dailyBtcdStats: Map<number, { totalRealBtc: number; totalTokenAmount: number }> = new Map();

  const weeklyBorrowedStats: Map<number, { count: number; totalRealBtc: number; totalTokenAmount: number }> = new Map();
  const weeklyBtcdStats: Map<number, { totalRealBtc: number; totalTokenAmount: number }> = new Map();

  const monthlyBorrowedStats: Map<number, { count: number; totalRealBtc: number; totalTokenAmount: number }> = new Map();
  const monthlyBtcdStats: Map<number, { totalRealBtc: number; totalTokenAmount: number }> = new Map();

  allRecords.forEach(r => {
    if (r.details?.borrowedTime) {
      const dayTimestamp = getUnitStartTimestamp(r.details.borrowedTime, 'day');
      const existing = dailyBorrowedStats.get(dayTimestamp) || { count: 0, totalRealBtc: 0, totalTokenAmount: 0 };
      const existingBtcd = dailyBtcdStats.get(dayTimestamp) || { totalRealBtc: 0, totalTokenAmount: 0 };

      existing.count += 1;
      let lockedBTC = parseFloat(r.details.realBtcAmount || '0')
      let btcdAmount = parseFloat(r.tokenAmount || '0');

      existing.totalRealBtc += lockedBTC;
      existing.totalTokenAmount += btcdAmount
      dailyBorrowedStats.set(dayTimestamp, existing);

      existingBtcd.totalRealBtc += lockedBTC;
      existingBtcd.totalTokenAmount += btcdAmount;
      dailyBtcdStats.set(dayTimestamp, existingBtcd);

      const weekTimestamp = getUnitStartTimestamp(r.details.borrowedTime, 'week');
      const existingWeek = weeklyBorrowedStats.get(weekTimestamp) || { count: 0, totalRealBtc: 0, totalTokenAmount: 0 };
      const existingWeekBtcd = weeklyBtcdStats.get(weekTimestamp) || { totalRealBtc: 0, totalTokenAmount: 0 };

      existingWeek.count += 1;
      existingWeek.totalRealBtc += lockedBTC;
      existingWeek.totalTokenAmount += btcdAmount;
      weeklyBorrowedStats.set(weekTimestamp, existingWeek);

      existingWeekBtcd.totalRealBtc += lockedBTC;
      existingWeekBtcd.totalTokenAmount += btcdAmount;
      weeklyBtcdStats.set(weekTimestamp, existingWeekBtcd);

      const monthTimestamp = getUnitStartTimestamp(r.details.borrowedTime, 'month');
      const existingMonth = monthlyBorrowedStats.get(monthTimestamp) || { count: 0, totalRealBtc: 0, totalTokenAmount: 0 };
      const existingMonthBtcd = monthlyBtcdStats.get(monthTimestamp) || { totalRealBtc: 0, totalTokenAmount: 0 };

      existingMonth.count += 1;
      existingMonth.totalRealBtc += lockedBTC;
      existingMonth.totalTokenAmount += btcdAmount;
      monthlyBorrowedStats.set(monthTimestamp, existingMonth);

      existingMonthBtcd.totalRealBtc += lockedBTC;
      existingMonthBtcd.totalTokenAmount += btcdAmount;
      monthlyBtcdStats.set(monthTimestamp, existingMonthBtcd);

      // 订单已还款，需要解锁btc并销毁btcd
      if (r.details.borrowerRepaidTime) {
        const dayTimestamp = getUnitStartTimestamp(r.details.borrowerRepaidTime, 'day');
        const existingBtcd = dailyBtcdStats.get(dayTimestamp) || { totalRealBtc: 0, totalTokenAmount: 0 };

        existingBtcd.totalRealBtc -= parseFloat(r.details.realBtcAmount || '0');
        existingBtcd.totalTokenAmount -= parseFloat(r.tokenAmount || '0');;
        dailyBtcdStats.set(dayTimestamp, existingBtcd);

        const weekTimestamp = getUnitStartTimestamp(r.details.borrowerRepaidTime, 'week');
        const existingWeekBtcd = weeklyBtcdStats.get(weekTimestamp) || { totalRealBtc: 0, totalTokenAmount: 0 };

        existingWeekBtcd.totalRealBtc -= parseFloat(r.details.realBtcAmount || '0');
        existingWeekBtcd.totalTokenAmount -= parseFloat(r.tokenAmount || '0');
        weeklyBtcdStats.set(weekTimestamp, existingWeekBtcd);

        const monthTimestamp = getUnitStartTimestamp(r.details.borrowerRepaidTime, 'month');
        const existingMonthBtcd = monthlyBtcdStats.get(monthTimestamp) || { totalRealBtc: 0, totalTokenAmount: 0 };

        existingMonthBtcd.totalRealBtc -= parseFloat(r.details.realBtcAmount || '0');
        existingMonthBtcd.totalTokenAmount -= parseFloat(r.tokenAmount || '0');
        monthlyBtcdStats.set(monthTimestamp, existingMonthBtcd);
      }
    }
  });

  // 转换为数组并按日期排序（用于趋势图）
  const dailyBorrowedArray = Array.from(dailyBorrowedStats.entries())
    .map(([timestamp, data]) => ({
      date: formatTimestampDisplay(timestamp, 'day'),
      timestamp,
      count: data.count,
      totalRealBtc: data.totalRealBtc,
      totalTokenAmount: data.totalTokenAmount
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // 打印每日借出统计
  console.log(`\n===== 每日借出订单统计 (共 ${dailyBorrowedArray.length} 天) =====`);
  dailyBorrowedArray.slice(-7).reverse().forEach(day => {
    console.log(`  ${day.date}: 订单数=${day.count}, BTC=${day.totalRealBtc.toFixed(4)}, BTCD=${day.totalTokenAmount.toFixed(2)}`);
  });

  // 转换为数组并按日期排序（用于趋势图）
  const dailyBtcdArray = Array.from(dailyBtcdStats.entries())
    .map(([timestamp, data]) => ({
      date: formatTimestampDisplay(timestamp, 'day'),
      timestamp,
      totalRealBtc: data.totalRealBtc,
      totalTokenAmount: data.totalTokenAmount
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // 打印每日BTCD统计 (注意：有些订单未使用Discount，所以存在totalRealBtc为正，但totalTokenAmount为负的情况)
  console.log(`\n===== 每日 BTCD 增量统计 (共 ${dailyBtcdArray.length} 天) =====`);
  dailyBtcdArray.slice(-7).reverse().forEach(day => {
    console.log(`  ${day.date}: BTC=${day.totalRealBtc.toFixed(4)}, BTCD=${day.totalTokenAmount.toFixed(2)}`);
  });

  // 转换为数组并按日期排序（用于趋势图）
  const weeklyBorrowedArray = Array.from(weeklyBorrowedStats.entries())
    .map(([timestamp, data]) => ({
      date: formatTimestampDisplay(timestamp, 'week'),
      timestamp,
      count: data.count,
      totalRealBtc: data.totalRealBtc,
      totalTokenAmount: data.totalTokenAmount
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // 打印每周借出订单统计
  console.log(`\n===== 每周借出订单统计 (共 ${weeklyBorrowedArray.length} 周) =====`);
  weeklyBorrowedArray.slice(-7).reverse().forEach(week => {
  // weeklyBorrowedArray.reverse().forEach(week => {
    console.log(`  ${week.date}: 订单数=${week.count}, BTC=${week.totalRealBtc.toFixed(4)}, BTCD=${week.totalTokenAmount.toFixed(2)}`);
  });

  // 转换为数组并按日期排序（用于趋势图）
  const weeklyBtcdArray = Array.from(weeklyBtcdStats.entries())
    .map(([timestamp, data]) => ({
      date: formatTimestampDisplay(timestamp, 'week'),
      timestamp,
      totalRealBtc: data.totalRealBtc,
      totalTokenAmount: data.totalTokenAmount
    }))
    .sort((a, b) => a.timestamp - b.timestamp);


  // 打印每周BTCD统计
  console.log(`\n===== 每周 BTCD 增量统计 (共 ${weeklyBtcdArray.length} 周) =====`);
  weeklyBtcdArray.slice(-7).reverse().forEach(week => {
  // weeklyBtcdArray.reverse().forEach(week => {
    console.log(`  ${week.date}: BTC=${week.totalRealBtc.toFixed(4)}, BTCD=${week.totalTokenAmount.toFixed(2)}`);
  });


  const monthlyBorrowedArray = Array.from(monthlyBorrowedStats.entries())
    .map(([timestamp, data]) => ({
      date: formatTimestampDisplay(timestamp, 'month'),
      timestamp,
      count: data.count,
      totalRealBtc: data.totalRealBtc,
      totalTokenAmount: data.totalTokenAmount
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // 打印每月借出订单统计
  console.log(`\n===== 每月借出订单统计 (共 ${monthlyBorrowedArray.length} 月) =====`);
  monthlyBorrowedArray.slice(-7).reverse().forEach(month => {
    console.log(`  ${month.date}: 订单数=${month.count}, BTC=${month.totalRealBtc.toFixed(4)}, BTCD=${month.totalTokenAmount.toFixed(2)}`);
  });

  // 转换为数组并按日期排序（用于趋势图）
  const monthlyBtcdArray = Array.from(monthlyBtcdStats.entries())
    .map(([timestamp, data]) => ({
      date: formatTimestampDisplay(timestamp, 'month'),
      timestamp,
      totalRealBtc: data.totalRealBtc,
      totalTokenAmount: data.totalTokenAmount
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // 打印每月BTCD统计
  console.log(`\n===== 每月 BTCD 增量统计 (共 ${monthlyBtcdArray.length} 月) =====`);
  monthlyBtcdArray.slice(-7).reverse().forEach(month => {
    console.log(`  ${month.date}: BTC=${month.totalRealBtc.toFixed(4)}, BTCD=${month.totalTokenAmount.toFixed(2)}`);
  });

  // ===== 用户统计 (基于 details.borrower) =====
  // 零地址常量
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  // 筛选有效的用户订单（borrower 不为空且不是零地址，且已被 take）
  const userOrders = allRecords.filter(r =>
    r.details?.borrower &&
    r.details.borrower !== ZERO_ADDRESS &&
    r.details.takenTime > 0
  );

  // 1. 统计用户总数 (去重)
  const uniqueUsers = new Set(userOrders.map(r => r.details!.borrower.toLowerCase()));
  const totalUsers = uniqueUsers.size;

  // 2. 统计每天/每周用户增加数
  // 按用户首次 take 订单时间分组
  const userFirstTakenTime: Map<string, number> = new Map();
  userOrders.forEach(r => {
    const user = r.details!.borrower.toLowerCase();
    const takenTime = r.details!.takenTime;
    const existing = userFirstTakenTime.get(user);
    if (!existing || takenTime < existing) {
      userFirstTakenTime.set(user, takenTime);
    }
  });

  // 按天统计新用户
  const dailyNewUsers: Map<number, Set<string>> = new Map();
  const weeklyNewUsers: Map<number, Set<string>> = new Map();

  userFirstTakenTime.forEach((firstTakenTime, user) => {
    const dayTimestamp = getUnitStartTimestamp(firstTakenTime, 'day');
    const weekTimestamp = getUnitStartTimestamp(firstTakenTime, 'week');

    if (!dailyNewUsers.has(dayTimestamp)) {
      dailyNewUsers.set(dayTimestamp, new Set());
    }
    dailyNewUsers.get(dayTimestamp)!.add(user);

    if (!weeklyNewUsers.has(weekTimestamp)) {
      weeklyNewUsers.set(weekTimestamp, new Set());
    }
    weeklyNewUsers.get(weekTimestamp)!.add(user);
  });

  // 转换为数组并按日期排序
  const dailyNewUsersArray = Array.from(dailyNewUsers.entries())
    .map(([timestamp, users]) => ({
      date: formatTimestampDisplay(timestamp, 'day'),
      timestamp,
      count: users.size
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const weeklyNewUsersArray = Array.from(weeklyNewUsers.entries())
    .map(([timestamp, users]) => ({
      date: formatTimestampDisplay(timestamp, 'week'),
      timestamp,
      count: users.size
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  // 3. 用户 take 订单数排行榜
  const userOrderCount: Map<string, number> = new Map();
  userOrders.forEach(r => {
    const user = r.details!.borrower.toLowerCase();
    userOrderCount.set(user, (userOrderCount.get(user) || 0) + 1);
  });

  // 按订单数量降序排序
  const userOrderRanking = Array.from(userOrderCount.entries())
    .map(([user, count]) => ({ user, count }))
    .sort((a, b) => b.count - a.count);

  // 打印用户统计
  console.log(`\n===== 用户统计 (Borrower) =====`);
  console.log(`用户总数: ${formatWithCommas(totalUsers, 0)}`);
  console.log(`用户订单总数: ${formatWithCommas(userOrders.length, 0)}`);

  // 打印每日新增用户
  console.log(`\n===== 每日新增用户 (共 ${dailyNewUsersArray.length} 天) =====`);
  dailyNewUsersArray.slice(-7).reverse().forEach(day => {
    console.log(`  ${day.date}: 新增用户数=${day.count}`);
  });

  // 打印每周新增用户
  console.log(`\n===== 每周新增用户 (共 ${weeklyNewUsersArray.length} 周) =====`);
  weeklyNewUsersArray.reverse().forEach(week => {
    console.log(`  ${week.date}: 新增用户数=${week.count}`);
  });

  // 打印用户 take 订单数排行榜 (Top 20)
  console.log(`\n===== 用户 Take 订单数排行榜 (Top 20) =====`);
  userOrderRanking.slice(0, 20).forEach((item, index) => {
    console.log(`  ${(index + 1).toString().padStart(2, ' ')}. ${item.user}: ${formatWithCommas(item.count, 0)} 单`);
  });

  console.log(`\n===== 订单统计 =====`);
  console.log(`总订单数: ${formatWithCommas(stats.totalOrders, 0)}`);
  const validOrdersPercent = stats.totalOrders > 0 ? ((stats.validOrders / stats.totalOrders) * 100).toFixed(2) : '0.00';
  console.log(`有效订单数: ${formatWithCommas(stats.validOrders, 0)} (${validOrdersPercent}%)`);
  const discountOrdersPercent = stats.validOrders > 0 ? ((stats.discountOrders / stats.validOrders) * 100).toFixed(2) : '0.00';
  console.log(`使用Discount订单数: ${formatWithCommas(stats.discountOrders, 0)} (${discountOrdersPercent}%)`);
  // console.log(`借款订单 (Borrow): ${stats.borrowOrders}`);
  // console.log(`出借订单 (Lend): ${stats.lendOrders}`);
  console.log(`累计总抵押 BTC: ${formatWithCommas(stats.totalCollateral, 2)} BTC`);
  console.log(`累计总抵押 BTC (使用Discount): ${formatWithCommas(stats.totalCollateralDiscount, 2)} BTC`);
  console.log(`累计BTCD铸造总量: ${formatWithCommas(stats.totalTokenAmount, 2)}`);
  console.log(`活跃订单铸造BTCD数量: ${formatWithCommas(stats.activeTokenAmount, 2)}`);
  console.log(`订单铸造BTCD总量（活跃订单 + 已清算订单）: ${formatWithCommas(stats.currentMintedBTCD, 2)}`);
  console.log(`锁定在订单中的BTCD总量: ${formatWithCommas(stats.lockedInOrdersBTCD, 2)}`);


  if (stats.firstOrderTime) {
    console.log(`\n时间范围:`);
    console.log(`  首个订单: ${stats.firstOrderTime} (区块 ${stats.firstOrderBlock})`);
    console.log(`  最新订单: ${stats.lastOrderTime} (区块 ${stats.lastOrderBlock})`);
  }

  // 显示当前已借出统计
  console.log(`\n===== 当前已借出统计 =====`);
  console.log(`  订单数: ${formatWithCommas(stats.currentBorrowed.count, 0)}`);
  console.log(`  抵押 BTC: ${formatWithCommas(stats.currentBorrowed.collateral, 8)} BTC`);
  console.log(`  抵押 BTC (使用Discount): ${formatWithCommas(stats.currentBorrowed.collateralDiscount, 8)} BTC`);
  console.log(`  BTCD 数量: ${formatWithCommas(stats.currentBorrowed.tokenAmount, 2)}`);

  // 显示已清算订单统计
  console.log(`\n===== 已清算订单统计 =====`);
  console.log(`  订单数: ${formatWithCommas(stats.liquidatedStats.count, 0)}`);
  console.log(`  抵押 BTC: ${formatWithCommas(stats.liquidatedStats.collateral, 8)} BTC`);
  console.log(`  BTCD数量: ${formatWithCommas(stats.liquidatedStats.tokenAmount, 2)}`);

  // 显示到期未还款订单统计
  console.log(`\n===== 到期未还款订单统计 =====`);
  console.log(`  订单数: ${formatWithCommas(stats.overdueStats.count, 0)}`);
  console.log(`  抵押 BTC: ${formatWithCommas(stats.overdueStats.collateral, 8)} BTC`);
  console.log(`  BTCD数量: ${formatWithCommas(stats.overdueStats.tokenAmount, 2)}`);

  // 显示状态统计
  console.log(`\n===== 订单状态分布 =====`);
  console.log(`  CREATED (已创建): ${formatWithCommas(stats.statusStats.created, 0)}`);
  console.log(`  TAKEN (已接单): ${formatWithCommas(stats.statusStats.taken, 0)}`);
  console.log(`  BORROWER_PROOF_SUBMITTED (借款人已提交BTC锁定证明): ${formatWithCommas(stats.statusStats.borrowerProofSubmitted, 0)}`);
  console.log(`  BORROWER_PAY_ARBITRATOR_SUBMITTED (借款人已提交仲裁员费用证明): ${formatWithCommas(stats.statusStats.borrowerPayArbitratorSubmitted, 0)}`);
  console.log(`  BORROWED (已借款): ${formatWithCommas(stats.statusStats.borrowed, 0)}`);
  console.log(`  REPAID (已还款): ${formatWithCommas(stats.statusStats.repaid, 0)}`);
  console.log(`  LENDER_PROOF_SUBMITTED (出借人已提交还款证明): ${formatWithCommas(stats.statusStats.lenderProofSubmitted, 0)}`);
  console.log(`  LENDER_PAYMENT_CONFIRMED (出借人付款已确认): ${formatWithCommas(stats.statusStats.lenderPaymentConfirmed, 0)}`);
  console.log(`  ARBITRATION_REQUESTED (已请求仲裁): ${formatWithCommas(stats.statusStats.arbitrationRequested, 0)}`);
  console.log(`  CLOSED (已关闭): ${formatWithCommas(stats.statusStats.closed, 0)}`);
  console.log(`  LIQUIDATED (已清算): ${formatWithCommas(stats.statusStats.liquidated, 0)}`);

  if (allRecords.length > 0) {
    // 构建用户统计对象
    const userStats = {
      totalUsers,
      totalUserOrders: userOrders.length,
      dailyNewUsers: dailyNewUsersArray,
      weeklyNewUsers: weeklyNewUsersArray,
      userOrderRanking: userOrderRanking.slice(0, 100) // 保存 Top 100
    };

    // 保存到文件
    fs.writeFileSync(outputFile, JSON.stringify({
      stats,
      userStats,
      contractAddress: LOAN_CONTRACT_ADDRESS,
      currentBlock,
      fetchedDetails: true,
      records: allRecords,
      liquidatedOrders: liquidatedOrders,
      overdueOrders: overdueOrders
    }, null, 2));
    console.log(`\n记录已保存到 ${outputFile}`);
    console.log(`本次新增订单: ${formatWithCommas(newRecords.length, 0)} 条`);
    console.log(`本次更新状态: ${formatWithCommas(updatedDetailsMap.size, 0)} 条`);
  }

  // 显示脚本执行总时间
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`\n===== 脚本执行完成 =====`);
  console.log(`总耗时: ${duration.toFixed(2)} 秒`);
}

main().catch(console.error);

