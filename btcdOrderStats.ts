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
// 可选：180 天订单统计起始时间（订单创建时间 >= 此时间的有效订单中，统计 limitedDays=180 占比）
const ORDER_180_START_TIME = (networkConfig[network] as Record<string, number>)?.['180order_start_time'];

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
  limitedDays: number;          // 订单期限（天）
  orderPeriod: number;          // 订单实际时长（天）= borrowerRepaidTime - borrowedTime，未还款则为 0
  orderPeriodStr: string;      // 订单实际时长字符串，如 "12.31天"
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
 * @param collateralByOrderId 可选，orderId(lowerCase) -> collateralRaw，用于在内部计算 useDiscount
 */
async function fetchOrderDetailsWithMulticall(
  provider: any,
  orderIds: string[],
  collateralByOrderId?: Map<string, string>
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
    'toLenderBtcTx',
    'limitedDays' // 订单期限（天）
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
          const limitedDaysResult = results[resultIdx++];

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

          const limitedDays = limitedDaysResult.success
            ? orderInterface.decodeFunctionResult('limitedDays', limitedDaysResult.returnData)[0].toNumber()
            : 0;

          // 订单实际时长（天）= borrowerRepaidTime - borrowedTime，未还款则为 0
          const orderPeriod =
            borrowerRepaidTime > 0 && borrowedTime > 0
              ? (borrowerRepaidTime - borrowedTime) / 86400
              : 0;
          const orderPeriodStr = `${orderPeriod.toFixed(2)}天`;

          const orderIdLower = orderId.toLowerCase();
          const useDiscount = collateralByOrderId
            ? realBtcAmountRaw === (collateralByOrderId.get(orderIdLower) ?? '')
            : false;

          orderDetailsMap.set(orderIdLower, {
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
            limitedDays,
            orderPeriod,
            orderPeriodStr,
            realBtcAmount,
            realBtcAmountRaw,
            useDiscount
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
    const collateralByOrderId = new Map(records.map(r => [r.orderId.toLowerCase(), r.collateralRaw]));
    const detailsMap = await fetchOrderDetailsWithMulticall(provider, orderIds, collateralByOrderId);

    records = records.map(record => ({
      ...record,
      details: detailsMap.get(record.orderId.toLowerCase())
    }));
  }

  return { records };
}

// ========== main 拆出的辅助函数 ==========

interface MainArgs {
  orderType: number | undefined;
  limit: number | undefined;
  beforeBlock: number | undefined;
  fetchAll: boolean;
  skipTimestamp: boolean;
  fetchDetails: boolean;
}

function parseMainArgs(args: string[]): MainArgs {
  let orderType: number | undefined;
  let limit: number | undefined;
  let beforeBlock: number | undefined;
  let fetchAll = true;
  let skipTimestamp = true;
  let fetchDetails = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--network' && args[i + 1]) {
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
    } else if (args[i] === '--fetch-details') {
      fetchDetails = true;
    }
  }
  return { orderType, limit, beforeBlock, fetchAll, skipTimestamp, fetchDetails };
}

function loadExistingOrderData(outputFile: string): { existingRecords: OrderRecord[]; savedCurrentBlock: number } {
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
  return { existingRecords, savedCurrentBlock };
}

async function updateDetailsAndMergeRecords(
  provider: any,
  existingRecords: OrderRecord[],
  newRecords: OrderRecord[]
): Promise<{ allRecords: OrderRecord[]; updatedDetailsMap: Map<string, OrderDetails> }> {
  const nonClosedOrders = existingRecords.filter(r => r.details?.status !== OrderStatus.CLOSED);
  console.log(`\n需要更新状态的订单 (非 Closed/Cancelled): ${nonClosedOrders.length} 条`);

  let updatedDetailsMap = new Map<string, OrderDetails>();
  if (nonClosedOrders.length > 0) {
    const orderIdsToUpdate = nonClosedOrders.map(r => r.orderId);
    const collateralByOrderId = new Map(nonClosedOrders.map(r => [r.orderId.toLowerCase(), r.collateralRaw]));
    updatedDetailsMap = await fetchOrderDetailsWithMulticall(provider, orderIdsToUpdate, collateralByOrderId);
  }

  const existingRecordsMap = new Map<string, OrderRecord>();
  for (const record of existingRecords) {
    const orderId = record.orderId.toLowerCase();
    if (updatedDetailsMap.has(orderId)) {
      record.details = updatedDetailsMap.get(orderId)!;
    }
    existingRecordsMap.set(orderId, record);
  }
  for (const newRecord of newRecords) {
    const orderId = newRecord.orderId.toLowerCase();
    if (!existingRecordsMap.has(orderId)) {
      existingRecordsMap.set(orderId, newRecord);
    }
  }

  const allRecords = Array.from(existingRecordsMap.values());
  allRecords.sort((a, b) => a.blockNumber - b.blockNumber);
  return { allRecords, updatedDetailsMap };
}

/** 派生订单列表与中间统计量，供 buildOrderStats 使用 */
interface DerivedOrderLists {
  borrowedOrders: OrderRecord[];
  repaidOrders: OrderRecord[];
  liquidatedOrders: OrderRecord[];
  overdueOrders: OrderRecord[];
  alloverdueOrders: OrderRecord[];
  validOrdersList: OrderRecord[];
  discountOrdersList: OrderRecord[];
  takenOrdersList: OrderRecord[];
  btcdRepaidOrdersList: OrderRecord[];
  avgOrderPeriodDays: number;
  avgOrderPeriodStr: string;
  avgOrderPeriodDaysBiggerThan10: number;
  avgOrderPeriodStrBiggerThan10: string;
}

function computeDerivedOrderLists(allRecords: OrderRecord[], nowTimestamp: number): DerivedOrderLists {
  const borrowedOrders = allRecords.filter(r => r.details?.status === OrderStatus.BORROWED);
  const repaidOrders = allRecords.filter(r => r.details?.status === OrderStatus.REPAID);
  const liquidatedOrders = allRecords.filter(r =>
    r.details?.status === OrderStatus.CLOSED &&
    r.details?.borrowedTime > 0 &&
    !r.details?.borrowerRepaidTime
  );
  const overdueOrders = allRecords.filter(r =>
    r.details?.status === OrderStatus.BORROWED &&
    r.details?.deadLinesData?.repayDeadLine > 0 &&
    r.details?.deadLinesData?.repayDeadLine < nowTimestamp &&
    !r.details?.borrowerRepaidTime
  );
  const alloverdueOrders = allRecords.filter(r =>
    r.details?.borrowedTime > 0 &&
    !r.details?.borrowerRepaidTime &&
    r.details?.deadLinesData?.repayDeadLine < nowTimestamp
  );
  const validOrdersList = allRecords.filter(r => r.details?.borrowedTime > 0);
  const discountOrdersList = validOrdersList.filter(r => r.details?.useDiscount === true);
  const takenOrdersList = allRecords.filter(r => r.details?.takenTime > 0);
  const btcdRepaidOrdersList = allRecords.filter(r => r.details?.borrowerRepaidTime > 0);

  const totalOrderPeriodDays = btcdRepaidOrdersList.reduce((sum, r) => sum + (r.details?.orderPeriod ?? 0), 0);
  const avgOrderPeriodDays = btcdRepaidOrdersList.length > 0 ? totalOrderPeriodDays / btcdRepaidOrdersList.length : 0;
  const avgOrderPeriodStr = `${avgOrderPeriodDays.toFixed(2)}天`;

  const btcdRepaidOrdersAmountBiggerThan10List = btcdRepaidOrdersList.filter(r => parseFloat(r.tokenAmount) > 10 && r.details?.limitedDays >= 90);
  const totalOrderPeriodDaysBiggerThan10 = btcdRepaidOrdersAmountBiggerThan10List.reduce((sum, r) => sum + (r.details?.orderPeriod ?? 0), 0);
  const avgOrderPeriodDaysBiggerThan10 = btcdRepaidOrdersAmountBiggerThan10List.length > 0 ? totalOrderPeriodDaysBiggerThan10 / btcdRepaidOrdersAmountBiggerThan10List.length : 0;
  const avgOrderPeriodStrBiggerThan10 = `${avgOrderPeriodDaysBiggerThan10.toFixed(2)}天`;

  return {
    borrowedOrders,
    repaidOrders,
    liquidatedOrders,
    overdueOrders,
    alloverdueOrders,
    validOrdersList,
    discountOrdersList,
    takenOrdersList,
    btcdRepaidOrdersList,
    avgOrderPeriodDays,
    avgOrderPeriodStr,
    avgOrderPeriodDaysBiggerThan10,
    avgOrderPeriodStrBiggerThan10
  };
}

function computeOverdueRankings(alloverdueOrders: OrderRecord[]): {
  overdueRankByBorrower: { address: string; count: number }[];
  overdueRankByBorrowerBtcAddress: { address: string; count: number }[];
} {
  const overdueCountByBorrower = new Map<string, number>();
  for (const r of alloverdueOrders) {
    const addr = (r.details!.borrower || '').toLowerCase();
    if (addr) overdueCountByBorrower.set(addr, (overdueCountByBorrower.get(addr) ?? 0) + 1);
  }
  const overdueRankByBorrower = [...overdueCountByBorrower.entries()]
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count);

  const overdueCountByBtcAddress = new Map<string, number>();
  for (const r of alloverdueOrders) {
    const addr = (r.details!.borrowerBtcAddress || '').trim();
    if (addr) overdueCountByBtcAddress.set(addr, (overdueCountByBtcAddress.get(addr) ?? 0) + 1);
  }
  const overdueRankByBorrowerBtcAddress = [...overdueCountByBtcAddress.entries()]
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count);

  return { overdueRankByBorrower, overdueRankByBorrowerBtcAddress };
}

function computeLimitedDays180AfterStart(allRecords: OrderRecord[]): {
  total: number;
  limitedDays180Count: number;
  ratio: number;
  ratioStr: string;
} | null {
  if (ORDER_180_START_TIME == null) return null;
  const startTime = ORDER_180_START_TIME;
  const validOrdersAfter180Start = allRecords.filter(
    r => (r.details?.borrowedTime ?? 0) > 0 && (r.details?.createTime ?? 0) >= startTime
  );
  const count180 = validOrdersAfter180Start.filter(r => r.details?.limitedDays === 180).length;
  const total = validOrdersAfter180Start.length;
  const ratio = total > 0 ? count180 / total : 0;
  return {
    total,
    limitedDays180Count: count180,
    ratio,
    ratioStr: `${(ratio * 100).toFixed(2)}%`
  };
}

function buildOrderStats(
  allRecords: OrderRecord[],
  derived: DerivedOrderLists,
  limitedDays180AfterStart: { total: number; limitedDays180Count: number; ratio: number; ratioStr: string } | null
): any {
  const {
    borrowedOrders,
    liquidatedOrders,
    overdueOrders,
    validOrdersList,
    takenOrdersList,
    discountOrdersList,
    avgOrderPeriodDays,
    avgOrderPeriodStr,
    avgOrderPeriodDaysBiggerThan10,
    avgOrderPeriodStrBiggerThan10
  } = derived;

  return {
    totalOrders: allRecords.length,
    validOrders: validOrdersList.length,
    limitedDays180Count: validOrdersList.filter(r => r.details?.limitedDays === 180).length,
    limitedDays180AfterStart,
    takenOrders: takenOrdersList.length,
    discountOrders: discountOrdersList.length,
    borrowOrders: allRecords.filter(r => r.orderType === OrderType.Borrow).length,
    lendOrders: allRecords.filter(r => r.orderType === OrderType.Lend).length,
    totalCollateral: allRecords.filter(r => r.details?.borrowedTime > 0).reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
    totalCollateralDiscount: allRecords.filter(r => r.details?.borrowedTime > 0).reduce((sum, r) => sum + parseFloat(r.collateral), 0),
    totalTokenAmount: allRecords.filter(r => r.details?.borrowedTime > 0).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    activeTokenAmount: allRecords.filter(r => r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    currentMintedBTCD: allRecords.filter(r => r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0) +
      liquidatedOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    lockedInOrdersBTCD: allRecords.filter(r => r.details?.status !== OrderStatus.BORROWED && r.details?.status !== OrderStatus.CLOSED).reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0),
    uniqueTokens: [...new Set(allRecords.map(r => r.token))],
    avgOrderPeriodDays,
    avgOrderPeriodStr,
    avgOrderPeriodDaysBiggerThan10,
    avgOrderPeriodStrBiggerThan10,
    firstOrderBlock: allRecords.length > 0 ? allRecords[0].blockNumber : null,
    lastOrderBlock: allRecords.length > 0 ? allRecords[allRecords.length - 1].blockNumber : null,
    firstOrderTime: allRecords.length > 0 ? allRecords[0].timestampStr : null,
    lastOrderTime: allRecords.length > 0 ? allRecords[allRecords.length - 1].timestampStr : null,
    currentBorrowed: {
      count: borrowedOrders.length,
      collateral: borrowedOrders.reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
      collateralDiscount: borrowedOrders.reduce((sum, r) => sum + parseFloat(r.collateral), 0),
      tokenAmount: borrowedOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0)
    },
    liquidatedStats: {
      count: liquidatedOrders.length,
      collateral: liquidatedOrders.reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
      tokenAmount: liquidatedOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0)
    },
    overdueStats: {
      count: overdueOrders.length,
      collateral: overdueOrders.reduce((sum, r) => sum + parseFloat(r.details.realBtcAmount), 0),
      tokenAmount: overdueOrders.reduce((sum, r) => sum + parseFloat(r.tokenAmount), 0)
    },
    statusStats: {
      created: allRecords.filter(r => r.details?.status === OrderStatus.CREATED).length,
      taken: allRecords.filter(r => r.details?.status === OrderStatus.TAKEN).length,
      borrowerProofSubmitted: allRecords.filter(r => r.details?.status === OrderStatus.BORROWER_PROOF_SUBMITTED).length,
      borrowerPayArbitratorSubmitted: allRecords.filter(r => r.details?.status === OrderStatus.BORROWER_PAY_ARBITRATOR_SUBMITTED).length,
      borrowed: borrowedOrders.length,
      repaid: derived.repaidOrders.length,
      lenderProofSubmitted: allRecords.filter(r => r.details?.status === OrderStatus.LENDER_PROOF_SUBMITTED).length,
      lenderPaymentConfirmed: allRecords.filter(r => r.details?.status === OrderStatus.LENDER_PAYMENT_CONFIRMED).length,
      arbitrationRequested: allRecords.filter(r => r.details?.status === OrderStatus.ARBITRATION_REQUESTED).length,
      closed: allRecords.filter(r => r.details?.status === OrderStatus.CLOSED).length,
      liquidated: liquidatedOrders.length
    }
  };
}

/** 按天/周/月统计借出与 BTCD 增量，返回已排序的数组（用于趋势图与打印） */
function buildTimeSeriesStats(allRecords: OrderRecord[]): {
  dailyBorrowedArray: { date: string; timestamp: number; count: number; totalRealBtc: number; totalTokenAmount: number }[];
  dailyBtcdArray: { date: string; timestamp: number; totalRealBtc: number; totalTokenAmount: number }[];
  weeklyBorrowedArray: { date: string; timestamp: number; count: number; totalRealBtc: number; totalTokenAmount: number }[];
  weeklyBtcdArray: { date: string; timestamp: number; totalRealBtc: number; totalTokenAmount: number }[];
  monthlyBorrowedArray: { date: string; timestamp: number; count: number; totalRealBtc: number; totalTokenAmount: number }[];
  monthlyBtcdArray: { date: string; timestamp: number; totalRealBtc: number; totalTokenAmount: number }[];
} {
  const dailyBorrowedStats = new Map<number, { count: number; totalRealBtc: number; totalTokenAmount: number }>();
  const dailyBtcdStats = new Map<number, { totalRealBtc: number; totalTokenAmount: number }>();
  const weeklyBorrowedStats = new Map<number, { count: number; totalRealBtc: number; totalTokenAmount: number }>();
  const weeklyBtcdStats = new Map<number, { totalRealBtc: number; totalTokenAmount: number }>();
  const monthlyBorrowedStats = new Map<number, { count: number; totalRealBtc: number; totalTokenAmount: number }>();
  const monthlyBtcdStats = new Map<number, { totalRealBtc: number; totalTokenAmount: number }>();

  allRecords.forEach(r => {
    if (!r.details?.borrowedTime) return;
    const dayTimestamp = getUnitStartTimestamp(r.details.borrowedTime, 'day');
    const existing = dailyBorrowedStats.get(dayTimestamp) || { count: 0, totalRealBtc: 0, totalTokenAmount: 0 };
    const existingBtcd = dailyBtcdStats.get(dayTimestamp) || { totalRealBtc: 0, totalTokenAmount: 0 };
    const lockedBTC = parseFloat(r.details.realBtcAmount || '0');
    const btcdAmount = parseFloat(r.tokenAmount || '0');

    existing.count += 1;
    existing.totalRealBtc += lockedBTC;
    existing.totalTokenAmount += btcdAmount;
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

    if (r.details.borrowerRepaidTime) {
      const dayTs = getUnitStartTimestamp(r.details.borrowerRepaidTime, 'day');
      const eb = dailyBtcdStats.get(dayTs) || { totalRealBtc: 0, totalTokenAmount: 0 };
      eb.totalRealBtc -= parseFloat(r.details.realBtcAmount || '0');
      eb.totalTokenAmount -= parseFloat(r.tokenAmount || '0');
      dailyBtcdStats.set(dayTs, eb);
      const weekTs = getUnitStartTimestamp(r.details.borrowerRepaidTime, 'week');
      const ewb = weeklyBtcdStats.get(weekTs) || { totalRealBtc: 0, totalTokenAmount: 0 };
      ewb.totalRealBtc -= parseFloat(r.details.realBtcAmount || '0');
      ewb.totalTokenAmount -= parseFloat(r.tokenAmount || '0');
      weeklyBtcdStats.set(weekTs, ewb);
      const monthTs = getUnitStartTimestamp(r.details.borrowerRepaidTime, 'month');
      const emb = monthlyBtcdStats.get(monthTs) || { totalRealBtc: 0, totalTokenAmount: 0 };
      emb.totalRealBtc -= parseFloat(r.details.realBtcAmount || '0');
      emb.totalTokenAmount -= parseFloat(r.tokenAmount || '0');
      monthlyBtcdStats.set(monthTs, emb);
    }
  });

  const toDay = (ts: number, data: any) => ({ date: formatTimestampDisplay(ts, 'day'), timestamp: ts, ...data });
  const toWeek = (ts: number, data: any) => ({ date: formatTimestampDisplay(ts, 'week'), timestamp: ts, ...data });
  const toMonth = (ts: number, data: any) => ({ date: formatTimestampDisplay(ts, 'month'), timestamp: ts, ...data });
  const sortByTs = (a: { timestamp: number }, b: { timestamp: number }) => a.timestamp - b.timestamp;

  const dailyBorrowedArray = Array.from(dailyBorrowedStats.entries()).map(([timestamp, data]) => toDay(timestamp, data)).sort(sortByTs);
  const dailyBtcdArray = Array.from(dailyBtcdStats.entries()).map(([timestamp, data]) => toDay(timestamp, data)).sort(sortByTs);
  const weeklyBorrowedArray = Array.from(weeklyBorrowedStats.entries()).map(([timestamp, data]) => toWeek(timestamp, data)).sort(sortByTs);
  const weeklyBtcdArray = Array.from(weeklyBtcdStats.entries()).map(([timestamp, data]) => toWeek(timestamp, data)).sort(sortByTs);
  const monthlyBorrowedArray = Array.from(monthlyBorrowedStats.entries()).map(([timestamp, data]) => toMonth(timestamp, data)).sort(sortByTs);
  const monthlyBtcdArray = Array.from(monthlyBtcdStats.entries()).map(([timestamp, data]) => toMonth(timestamp, data)).sort(sortByTs);

  return {
    dailyBorrowedArray,
    dailyBtcdArray,
    weeklyBorrowedArray,
    weeklyBtcdArray,
    monthlyBorrowedArray,
    monthlyBtcdArray
  };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** 用户统计（EVM 借款人 + BTC 用户） */
function computeUserStats(allRecords: OrderRecord[]): {
  userOrders: OrderRecord[];
  totalUsers: number;
  dailyNewUsersArray: { date: string; timestamp: number; count: number }[];
  weeklyNewUsersArray: { date: string; timestamp: number; count: number }[];
  userOrderRanking: { user: string; count: number }[];
  totalBTCUsers: number;
  btcuserOrderRanking: { user: string; count: number }[];
} {
  const userOrders = allRecords.filter(r =>
    r.details?.borrower &&
    r.details.borrower !== ZERO_ADDRESS &&
    r.details.takenTime > 0
  );
  const uniqueUsers = new Set(userOrders.map(r => r.details!.borrower.toLowerCase()));
  const totalUsers = uniqueUsers.size;

  const userFirstTakenTime = new Map<string, number>();
  userOrders.forEach(r => {
    const user = r.details!.borrower.toLowerCase();
    const takenTime = r.details!.takenTime;
    const existing = userFirstTakenTime.get(user);
    if (!existing || takenTime < existing) userFirstTakenTime.set(user, takenTime);
  });

  const dailyNewUsers = new Map<number, Set<string>>();
  const weeklyNewUsers = new Map<number, Set<string>>();
  userFirstTakenTime.forEach((firstTakenTime, user) => {
    const dayTimestamp = getUnitStartTimestamp(firstTakenTime, 'day');
    const weekTimestamp = getUnitStartTimestamp(firstTakenTime, 'week');
    if (!dailyNewUsers.has(dayTimestamp)) dailyNewUsers.set(dayTimestamp, new Set());
    dailyNewUsers.get(dayTimestamp)!.add(user);
    if (!weeklyNewUsers.has(weekTimestamp)) weeklyNewUsers.set(weekTimestamp, new Set());
    weeklyNewUsers.get(weekTimestamp)!.add(user);
  });

  const dailyNewUsersArray = Array.from(dailyNewUsers.entries())
    .map(([timestamp, users]) => ({ date: formatTimestampDisplay(timestamp, 'day'), timestamp, count: users.size }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const weeklyNewUsersArray = Array.from(weeklyNewUsers.entries())
    .map(([timestamp, users]) => ({ date: formatTimestampDisplay(timestamp, 'week'), timestamp, count: users.size }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const userOrderCount = new Map<string, number>();
  userOrders.forEach(r => {
    const user = r.details!.borrower.toLowerCase();
    userOrderCount.set(user, (userOrderCount.get(user) || 0) + 1);
  });
  const userOrderRanking = Array.from(userOrderCount.entries())
    .map(([user, count]) => ({ user, count }))
    .sort((a, b) => b.count - a.count);

  const uniqueBTCUsers = new Set(userOrders.map(r => r.details!.borrowerBtcAddress.toLowerCase()));
  const totalBTCUsers = uniqueBTCUsers.size;
  const btcuserOrderCount = new Map<string, number>();
  userOrders.forEach(r => {
    const user = r.details!.borrowerBtcAddress.toLowerCase();
    btcuserOrderCount.set(user, (btcuserOrderCount.get(user) || 0) + 1);
  });
  const btcuserOrderRanking = Array.from(btcuserOrderCount.entries())
    .map(([user, count]) => ({ user, count }))
    .sort((a, b) => b.count - a.count);

  return {
    userOrders,
    totalUsers,
    dailyNewUsersArray,
    weeklyNewUsersArray,
    userOrderRanking,
    totalBTCUsers,
    btcuserOrderRanking
  };
}

function printTimeSeriesStats(ts: ReturnType<typeof buildTimeSeriesStats>): void {
  console.log(`\n===== 每日借出订单统计 (共 ${ts.dailyBorrowedArray.length} 天) =====`);
  ts.dailyBorrowedArray.slice(-7).reverse().forEach(day => {
    console.log(`  ${day.date}: 订单数=${day.count}, BTC=${day.totalRealBtc.toFixed(4)}, BTCD=${day.totalTokenAmount.toFixed(2)}`);
  });
  console.log(`\n===== 每日 BTCD 增量统计 (共 ${ts.dailyBtcdArray.length} 天) =====`);
  ts.dailyBtcdArray.slice(-7).reverse().forEach(day => {
    console.log(`  ${day.date}: BTC=${day.totalRealBtc.toFixed(4)}, BTCD=${day.totalTokenAmount.toFixed(2)}`);
  });
  console.log(`\n===== 每周借出订单统计 (共 ${ts.weeklyBorrowedArray.length} 周) =====`);
  ts.weeklyBorrowedArray.slice(-7).reverse().forEach(week => {
    console.log(`  ${week.date}: 订单数=${week.count}, BTC=${week.totalRealBtc.toFixed(4)}, BTCD=${week.totalTokenAmount.toFixed(2)}`);
  });
  console.log(`\n===== 每周 BTCD 增量统计 (共 ${ts.weeklyBtcdArray.length} 周) =====`);
  ts.weeklyBtcdArray.slice(-7).reverse().forEach(week => {
    console.log(`  ${week.date}: BTC=${week.totalRealBtc.toFixed(4)}, BTCD=${week.totalTokenAmount.toFixed(2)}`);
  });
  console.log(`\n===== 每月借出订单统计 (共 ${ts.monthlyBorrowedArray.length} 月) =====`);
  ts.monthlyBorrowedArray.slice(-7).reverse().forEach(month => {
    console.log(`  ${month.date}: 订单数=${month.count}, BTC=${month.totalRealBtc.toFixed(4)}, BTCD=${month.totalTokenAmount.toFixed(2)}`);
  });
  console.log(`\n===== 每月 BTCD 增量统计 (共 ${ts.monthlyBtcdArray.length} 月) =====`);
  ts.monthlyBtcdArray.slice(-7).reverse().forEach(month => {
    console.log(`  ${month.date}: BTC=${month.totalRealBtc.toFixed(4)}, BTCD=${month.totalTokenAmount.toFixed(2)}`);
  });
}

function printUserStats(us: ReturnType<typeof computeUserStats>): void {
  console.log(`\n===== 用户统计 (Borrower) =====`);
  console.log(`用户总数: ${formatWithCommas(us.totalUsers, 0)}`);
  console.log(`用户订单总数: ${formatWithCommas(us.userOrders.length, 0)}`);
  console.log(`\n===== 每日新增用户 (共 ${us.dailyNewUsersArray.length} 天) =====`);
  us.dailyNewUsersArray.slice(-7).reverse().forEach(day => {
    console.log(`  ${day.date}: 新增用户数=${day.count}`);
  });
  console.log(`\n===== 每周新增用户 (共 ${us.weeklyNewUsersArray.length} 周) =====`);
  us.weeklyNewUsersArray.slice().reverse().forEach(week => {
    console.log(`  ${week.date}: 新增用户数=${week.count}`);
  });
  console.log(`\n===== 用户 Take 订单数排行榜 (Top 20) =====`);
  us.userOrderRanking.slice(0, 20).forEach((item, index) => {
    console.log(`  ${(index + 1).toString().padStart(2, ' ')}. ${item.user}: ${formatWithCommas(item.count, 0)} 单`);
  });
  console.log(`\n===== BTC用户总数 =====`);
  console.log(`BTC用户总数: ${formatWithCommas(us.totalBTCUsers, 0)}`);
  console.log(`\n===== BTC用户 Take 订单数排行榜 (Top 20) =====`);
  us.btcuserOrderRanking.slice(0, 20).forEach((item, index) => {
    console.log(`  ${(index + 1).toString().padStart(2, ' ')}. ${item.user}: ${formatWithCommas(item.count, 0)} 单`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const { orderType, limit, beforeBlock, fetchAll, skipTimestamp, fetchDetails } = parseMainArgs(args);

  const startTime = Date.now();
  console.log(`\n===== 获取 OrderCreated 事件 [网络: ${network}] =====`);

  const provider = new (ethers as any).providers.JsonRpcProvider(RPC_URL);
  const outputFile = `data/${network}/btcd_order_stats.json`;

  const currentBlock: number = await provider.getBlockNumber();
  console.log(`当前区块高度: ${currentBlock}`);

  const { existingRecords, savedCurrentBlock } = loadExistingOrderData(outputFile);
  let beforeBlockRes = beforeBlock;
  if (beforeBlockRes === undefined && savedCurrentBlock > 0) {
    beforeBlockRes = savedCurrentBlock;
  }

  console.log(`\n获取从区块 ${beforeBlockRes ? beforeBlockRes + 1 : INITIAL_START_BLOCK} 到 ${currentBlock} 的新订单...`);
  const { records: newRecords } = await getOrderCreatedLogs(provider, currentBlock, {
    orderType,
    limit,
    beforeBlock: beforeBlockRes,
    fetchAll,
    skipTimestamp,
    fetchDetails: true
  });
  console.log(`\n找到 ${newRecords.length} 条新订单`);

  const { allRecords, updatedDetailsMap } = await updateDetailsAndMergeRecords(provider, existingRecords, newRecords);

  const nowTimestamp = Math.floor(Date.now() / 1000);
  const derived = computeDerivedOrderLists(allRecords, nowTimestamp);
  const overdueRanks = computeOverdueRankings(derived.alloverdueOrders);
  const limitedDays180AfterStart = computeLimitedDays180AfterStart(allRecords);
  const stats = buildOrderStats(allRecords, derived, limitedDays180AfterStart);

  const timeSeries = buildTimeSeriesStats(allRecords);
  const userStatsData = computeUserStats(allRecords);

  printTimeSeriesStats(timeSeries);
  printUserStats(userStatsData);

  console.log(`\n===== 订单统计 =====`);
  console.log(`总订单数: ${formatWithCommas(stats.totalOrders, 0)}`);
  const validOrdersPercent = stats.totalOrders > 0 ? ((stats.validOrders / stats.totalOrders) * 100).toFixed(2) : '0.00';
  console.log(`有效订单数: ${formatWithCommas(stats.validOrders, 0)} (${validOrdersPercent}%)`);
  const takenOrdersPercent = stats.totalOrders > 0 ? ((stats.takenOrders / stats.totalOrders) * 100).toFixed(2) : '0.00';
  console.log(`已接单订单数: ${formatWithCommas(stats.takenOrders, 0)} (${takenOrdersPercent}%)`);
  const discountOrdersPercent = stats.validOrders > 0 ? ((stats.discountOrders / stats.validOrders) * 100).toFixed(2) : '0.00';
  console.log(`使用Discount订单数: ${formatWithCommas(stats.discountOrders, 0)} (${discountOrdersPercent}%)`);
  console.log(`有效订单中 limitedDays 为 180 天的订单数量: ${formatWithCommas(stats.limitedDays180Count, 0)}`);
  if (stats.limitedDays180AfterStart != null) {
    const s = stats.limitedDays180AfterStart;
    console.log(`[180order_start_time] 创建时间 >= 起始时间且已借款订单数: ${formatWithCommas(s.total, 0)}，其中 limitedDays=180: ${formatWithCommas(s.limitedDays180Count, 0)}，占比: ${s.ratioStr}`);
  }
  // console.log(`借款订单 (Borrow): ${stats.borrowOrders}`);
  // console.log(`出借订单 (Lend): ${stats.lendOrders}`);
  console.log(`累计总抵押 BTC: ${formatWithCommas(stats.totalCollateral, 2)} BTC`);
  console.log(`累计总抵押 BTC (使用Discount): ${formatWithCommas(stats.totalCollateralDiscount, 2)} BTC`);
  console.log(`累计BTCD铸造总量: ${formatWithCommas(stats.totalTokenAmount, 2)}`);
  console.log(`活跃订单铸造BTCD数量: ${formatWithCommas(stats.activeTokenAmount, 2)}`);
  console.log(`订单铸造BTCD总量（活跃订单 + 已清算订单）: ${formatWithCommas(stats.currentMintedBTCD, 2)}`);
  console.log(`锁定在订单中的BTCD总量: ${formatWithCommas(stats.lockedInOrdersBTCD, 2)}`);
  console.log(`已还款订单的平均实际时长: ${stats.avgOrderPeriodStr}`);
  console.log(`已还款订单的平均实际时长 (大于10 BTCD): ${stats.avgOrderPeriodStrBiggerThan10}`);


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

  const overdueRankBorrowerTop10 = overdueRanks.overdueRankByBorrower.slice(0, 10);
  const overdueRankBtcTop10 = overdueRanks.overdueRankByBorrowerBtcAddress.slice(0, 10);
  if (overdueRankBorrowerTop10.length > 0) {
    console.log(`过期排行 Top10 (EVM 用户 borrower):`);
    overdueRankBorrowerTop10.forEach((item, i) => {
      console.log(`    ${i + 1}. ${item.address} 过期订单数: ${item.count}`);
    });
  }
  if (overdueRankBtcTop10.length > 0) {
    console.log(`过期排行 Top10 (BTC 用户 borrowerBtcAddress):`);
    overdueRankBtcTop10.forEach((item, i) => {
      console.log(`    ${i + 1}. ${item.address} 过期订单数: ${item.count}`);
    });
  }

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


  // const repaidOrderIDs = new Set(repaidOrders.map(r => r.orderId));
  // console.log(`已还款订单ID: ${Array.from(repaidOrderIDs).join(', ')}`);

  if (allRecords.length > 0) {
    const userStats = {
      totalUsers: userStatsData.totalUsers,
      totalUserOrders: userStatsData.userOrders.length,
      userOrderRanking: userStatsData.userOrderRanking.slice(0, 10)
    };

    // 保存到文件
    fs.writeFileSync(outputFile, JSON.stringify({
      stats,
      userStats,
      contractAddress: LOAN_CONTRACT_ADDRESS,
      currentBlock,
      fetchedDetails: true,
      records: allRecords,
      liquidatedOrders: derived.liquidatedOrders,
      overdueOrders: derived.overdueOrders
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

