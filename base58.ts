
// NOTE: Ideally the nodejs build should use the native buffer, browser should use the polyfill.
// Buf haven't found a way to make this work for typescript files at the rollup build level.
import * as bs58 from "bs58";
import * as bs58check from "bs58check";

/**
 * @Internal (tag for docs)
 */
export class Base58 {
  public static decode(base58: string): Buffer {
    return bs58.decode(base58);
  }

  public static encode(data: Buffer): string {
    return bs58.encode(data);
  }
}

export class Base58Check {
  public static decode(base58: string): Buffer {
    try {
      return bs58check.decode(base58);
    } catch (err) {
      throw new Error("Invalid base58 string when decode");
    }
  }

  public static encode(data: Buffer): string {
    return bs58check.encode(data);
  }
}
