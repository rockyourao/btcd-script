# BTCD Script

用于获取和分析 Elastos 区块链上 BTCD (BTC-backed Stablecoin) Token 相关事件数据的脚本工具集。

## 📖 简介

本项目提供了一套完整的脚本工具，用于：

- 获取 BTCD Token 的铸造/销毁事件
- 获取借贷合约的订单统计
- 获取质押合约的质押统计
- 获取跨链交易日志
- 分析跨链交易详情

## 🔧 环境要求

- Node.js >= 16
- npm 或 yarn

## 📦 安装

```bash
# 克隆仓库
git clone <repository-url>
cd btcd-script

# 安装依赖
npm install
```

## 🌐 支持的网络

| 网络 | RPC 地址 | 说明 |
|------|----------|------|
| `eco-prod` | https://api.elastos.cc/eco | Elastos ECO 网络 (主网) |
| `pgp-prod` | https://api.elastos.io/pgp | Elastos PGP 网络 (主网) |

网络配置详见 `networks.json` 文件。

## 🚀 使用方法

### 1. 获取 BTCD Transfer 事件

获取 BTCD Token 的所有铸造和销毁事件。

```bash
# 使用默认网络 (pgp-prod)
npx ts-node getBTCDTransfers.ts

# 指定网络
npx ts-node getBTCDTransfers.ts --network eco-prod

# 将 JSON 转换为 CSV
npx ts-node getBTCDTransfers.ts --to-csv

# 转换指定文件
npx ts-node getBTCDTransfers.ts --to-csv data/btcd_transfers_1212.json
```

**输出内容：**
- 总铸造量/销毁量/净流通量
- 通过 USDT 铸造/销毁的 BTCD 统计
- 所有 Transfer 记录保存到 `data/<network>/btcd_transfers.json`

### 2. 获取订单统计

获取 LoanContract 合约的 OrderCreated 事件并读取订单详细信息。

```bash
# 获取所有订单 (默认 eco-prod)
npx ts-node btcdOrderStats.ts

# 指定网络
npx ts-node btcdOrderStats.ts --network pgp-prod

# 获取最新 50 条
npx ts-node btcdOrderStats.ts --limit 50

# 按订单类型过滤 (0: Borrow, 1: Lend)
npx ts-node btcdOrderStats.ts --orderType 0

# 获取订单详细信息
npx ts-node btcdOrderStats.ts --fetch-details
```

**输出内容：**
- 订单状态分布 (CREATED, TAKEN, BORROWED, CLOSED 等)
- 累计抵押品/BTCD 铸造总量
- 当前已借出/已清算/到期未还款统计
- 按日/周/月的借出订单趋势
- 所有订单记录保存到 `data/<network>/btcd_order_stats.json`

**订单状态说明：**

| 状态 | 说明 |
|------|------|
| CREATED | 初始状态 |
| TAKEN | 已接单 |
| BORROWER_PROOF_SUBMITTED | 借款人已提交 BTC 锁定证明 |
| BORROWED | 已借款 (BTC 锁定证明已验证) |
| REPAID | 借款人已还款 |
| LENDER_PROOF_SUBMITTED | 出借人已提交还款证明 |
| CLOSED | 已关闭 (最终状态) |

### 3. 获取质押统计

获取 StakingFactory 合约的质押统计信息。

```bash
# 使用默认网络
npx ts-node btcdStakingStats.ts

# 指定网络
npx ts-node btcdStakingStats.ts --network pgp-prod

# 强制刷新 Token Transfer 历史
npx ts-node btcdStakingStats.ts --refresh-transfers
```

**输出内容：**
- 总 Staking 合约数
- 活跃/已到期 Staking 数
- Staked/Withdrawn/StakeExtended 事件统计
- Token Transfer 统计 (TransferIn/TransferOut)
- 活跃质押总量 (Native Token, Token1, Token2)
- 所有记录保存到 `data/<network>/btcd_staking_stats.json`

### 4. 获取跨链交易日志

从区块链获取跨链交易事件。

```bash
# 获取发送到指定地址的跨链交易 (最新 20 条)
npx ts-node getCrossChainLogs.ts --to <address>

# 获取最新 50 条
npx ts-node getCrossChainLogs.ts --to <address> --limit 50

# 从指定区块往前查找
npx ts-node getCrossChainLogs.ts --to <address> --before 3000000

# 获取所有跨链交易
npx ts-node getCrossChainLogs.ts --to <address> --all

# 按发送者过滤
npx ts-node getCrossChainLogs.ts --from <address>
```

**输出内容：**
- 跨链交易记录
- 总跨链金额
- 唯一发送者/接收者统计
- 保存到 `data/crosschain_*.json`

### 5. 分析跨链交易

分析指定跨链交易的事件详情。

```bash
npx ts-node analyzeCrossChainTx.ts <transaction-hash>

# 示例
npx ts-node analyzeCrossChainTx.ts 0x246e9504e0a4522671c85cee229dd50cffa51be218936371de70bdb0dee9f539
```

**输出内容：**
- 交易基本信息 (From, To, Value, Block)
- 所有事件日志及其 Topics
- 涉及的合约地址

## 📁 项目结构

```
btcd-script/
├── abi/                          # 合约 ABI 文件
│   ├── LoanContract.json         # 借贷合约 ABI
│   ├── Multicall3.json           # Multicall3 合约 ABI
│   ├── Order.json                # 订单合约 ABI
│   ├── Staking.json              # 质押合约 ABI
│   └── StakingFactory.json       # 质押工厂合约 ABI
├── data/                         # 输出数据目录
│   ├── eco-prod/                 # ECO 网络数据
│   │   ├── btcd_order_stats.json
│   │   ├── btcd_staking_stats.json
│   │   └── btcd_transfers.json
│   └── pgp-prod/                 # PGP 网络数据
│       ├── btcd_order_stats.json
│       ├── btcd_staking_stats.json
│       └── btcd_transfers.json
├── analyzeCrossChainTx.ts        # 跨链交易分析脚本
├── btcdOrderStats.ts             # 订单统计脚本
├── btcdStakingStats.ts           # 质押统计脚本
├── config.ts                     # 项目配置
├── getBTCDTransfers.ts           # BTCD Transfer 事件获取脚本
├── getCrossChainLogs.ts          # 跨链日志获取脚本
├── networks.json                  # 网络配置
├── package.json
└── tsconfig.json
```

## ⚙️ 配置说明

### config.ts

```typescript
// Blockscout API (ECO 浏览器)
export const BLOCKSCOUT_API = 'https://eco.elastos.io/api/v2';
export const BLOCKSCOUT_URL = 'https://eco.elastos.io';

// 批次大小配置
export const TIMESTAMP_BATCH_SIZE = 10000;
```

### networks.json

每个网络包含以下配置：

| 字段 | 说明 |
|------|------|
| `rpc_url` | RPC 节点地址 |
| `loan_contractaddress` | 借贷合约地址 |
| `issuer_contractaddress` | 发行者合约地址 |
| `stable_coin_contractaddress` | BTCD 稳定币合约地址 |
| `staking_factory_address` | 质押工厂合约地址 |
| `stakingToken1_decimals` | Token1 精度 |
| `stakingToken2_decimals` | Token2 精度 |
| `multicall3` | Multicall3 合约地址 |
| `start_block` | 起始区块 |
| `batch_size` | 查询批次大小 |

## 📊 数据格式

### btcd_transfers.json

```json
{
  "lastBlock": 12345678,
  "stats": {
    "totalBTCDMinted": "1000.0",
    "totalBTCDBurned": "500.0",
    "totalBTCDNetValue": "500.0",
    "usdtBTCDMinted": "800.0",
    "usdtBTCDBurned": "300.0",
    "usdtBTCDNetValue": "500.0"
  },
  "transfers": [
    {
      "from": "0x...",
      "to": "0x...",
      "value": "100.0",
      "valueRaw": "100000000000000000000",
      "blockNumber": 12345678,
      "timestamp": 1703721600,
      "timestampStr": "2024-12-28T00:00:00.000Z",
      "transactionHash": "0x..."
    }
  ]
}
```

### btcd_order_stats.json

```json
{
  "stats": {
    "totalOrders": 100,
    "validOrders": 80,
    "discountOrders": 20,
    "totalCollateral": 10.5,
    "totalTokenAmount": 500000,
    "currentBorrowed": {...},
    "liquidatedStats": {...},
    "statusStats": {...}
  },
  "contractAddress": "0x...",
  "currentBlock": 12345678,
  "records": [...]
}
```

## 🔑 关键技术

- **ethers.js v5** - 以太坊交互库
- **Multicall3** - 批量调用合约，减少 RPC 请求
- **增量更新** - 支持从上次同步的区块继续获取新数据
- **JSON-RPC Batch** - 批量获取区块时间戳，提高效率

## 📝 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

