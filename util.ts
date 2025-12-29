import { TIMESTAMP_BATCH_SIZE } from "./config";

const { ethers } = require('ethers');

/**
 * 将 topic 转换为地址格式
 */
export function topicToAddress(topic: string): string {
  return '0x' + topic.slice(26).toLowerCase();
}

/**
 * 将 topic 转换为 BigNumber
 */
export function topicToAmount(topic: string): any {
  return (ethers as any).BigNumber.from(topic);
}


// BTC 精度 (8 位小数)
const BTC_DECIMALS = 8;

/**
 * 将 satoshi 转换为 BTC
 */
export function formatBtc(satoshi: any): string {
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

/**
 * 将时间戳转换为可读字符串
 */
export function timestampToStr(timestamp: number): string {
  if (!timestamp || timestamp === 0) return '';
  return new Date(timestamp * 1000).toISOString();
}

/**
 * 获取指定时间戳所在的时间单位开始时间戳
 * @param {number} [timestamp=Date.now()] - 时间戳（毫秒）
 * @param {string} [unit='day'] - 时间单位: 'day' | 'week' | 'month'
 * @returns {number} 时间戳（秒）
 */
export function getUnitStartTimestamp(timestamp: number, unit: 'day' | 'week' | 'month' = 'day'): number {
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
export function formatTimestampDisplay(timestamp: number, unit: 'day' | 'week' | 'month' = 'week'): string {
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
 * 获取区块时间戳
 */
export async function getBlockTimestamps(blockNumbers: number[], rpcUrl: string): Promise<Map<number, number>> {
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

      const response = await fetch(rpcUrl, {
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