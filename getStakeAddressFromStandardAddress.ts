/*
  npx ts-node getStakeAddressFromStandardAddress.ts 0x246e9504e0a4522671c85cee229dd50cffa51be218936371de70bdb0dee9f539
*/

import { Base58Check } from "./base58";


enum Prefix {
  PrefixStandard = 0x21,
  PrefixMultiSign = 0x12,
  PrefixCrossChain = 0x4b,
  PrefixCRExpenses = 0x1c,
  PrefixDeposit = 0x1f,
  PrefixIDChain = 0x67,
  PrefixDestroy = 0,
  PrefixDPoSV2 = 0x3f
}

/** 仅适用于 Standard 单钥的「标准」前缀地址，例如首个外链地址 */
export function stakeAddrStrFromStandardAddressStr(stdAddrStr: string): string {
  const payload = Base58Check.decode(stdAddrStr); // 21 字节：1 前缀 + 20 hash
  if (payload[0] !== Prefix.PrefixStandard) {
    throw new Error("expect PrefixStandard address");
  }
  const out = Buffer.from(payload);
  out[0] = Prefix.PrefixDPoSV2;
  return Base58Check.encode(out);
}

async function main() {
  const stdAddrStr = process.argv[2];
  if (!stdAddrStr) {
    console.error("请提供标准地址");
    process.exit(1);
  }
  const stakeAddrStr = stakeAddrStrFromStandardAddressStr(stdAddrStr);
  console.log(stakeAddrStr);
}

main().catch(console.error);