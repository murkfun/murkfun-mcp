// CreateX CREATE3 address of a MurkFun token, mirrored from MurkFunFactory.tokenSalt / create3Address,
// and the vanity grinder behind create_token's `vanitySuffix`: the address is f(factory, the token's parameters, the
// dev's salt), so a suffix is just a ground dev salt. Uniform for every dev. The dev salt's top 20 bytes name the
// launch's one-time key (MurkFunFactory.launchKeyOf); only its low 12 bytes are free.
import crypto from "crypto";
import { keccak256, type Address, type Hex } from "viem";

export const CREATEX: Address = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";
/** keccak256 of CreateX's CREATE3 proxy init code 0x67363d3d37363d34f03d5260086018f3. */
const PROXY_HASH = hexBytes("0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f");
/** Longest suffix create_token grinds (16^5 ~ 1M tries on average). */
export const MAX_VANITY_HEX = 5;

function hexBytes(h: string): Uint8Array { return Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex")); }
const toHex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as Hex;
const k = (b: Uint8Array) => keccak256(b, "bytes");

/** CreateX salt: factory (20 bytes) | 0x00 (no chain id) | top 11 bytes of keccak256(paramsHash | devSalt). */
export function tokenSalt(factory: Address, paramsHash: Hex, devSalt: Hex): Hex {
  const h = k(new Uint8Array([...hexBytes(paramsHash), ...hexBytes(devSalt)]));
  return toHex(new Uint8Array([...hexBytes(factory), 0, ...h.slice(0, 11)]));
}

/** Address CreateX deploys for `deployer` with its msg.sender-guarded (no chain id) `salt`. */
export function create3Address(deployer: Address, salt: Hex): Address {
  const guarded = k(new Uint8Array([...new Uint8Array(12), ...hexBytes(deployer), ...hexBytes(salt)]));
  const proxy = k(new Uint8Array([0xff, ...hexBytes(CREATEX), ...guarded, ...PROXY_HASH])).slice(12);
  return toHex(k(new Uint8Array([0xd6, 0x94, ...proxy, 0x01])).slice(12)) as Address;
}

export const predictToken = (factory: Address, paramsHash: Hex, devSalt: Hex) => create3Address(factory, tokenSalt(factory, paramsHash, devSalt));

/** A dev salt naming `launchKey`: its address, then 12 random bytes. */
export function launchDevSalt(launchKey: Address): Hex {
  return toHex(new Uint8Array([...hexBytes(launchKey), ...crypto.randomBytes(12)]));
}

/** A dev salt naming `launchKey` whose token address ends with `suffix` (hex, case-insensitive), or throws after
 *  `maxTries`. */
export function grindDevSalt(factory: Address, paramsHash: Hex, suffix: string, launchKey: Address, maxTries = 16 ** (MAX_VANITY_HEX + 2)): { devSalt: Hex; address: Address; tries: number } {
  const want = suffix.toLowerCase().replace(/^0x/, "");
  if (!new RegExp(`^[0-9a-f]{1,${MAX_VANITY_HEX}}$`).test(want)) throw new Error(`vanitySuffix: 1-${MAX_VANITY_HEX} hex characters`);
  const salt = new Uint8Array(32);
  salt.set(hexBytes(launchKey), 0);
  salt.set(crypto.randomBytes(4), 20); // launch key | 4 random bytes | 8-byte counter
  for (let i = 0; i < maxTries; i++) {
    let c = i;
    for (let j = 31; j >= 24; j--) { salt[j] = c & 0xff; c = Math.floor(c / 256); }
    const devSalt = toHex(salt);
    const address = predictToken(factory, paramsHash, devSalt);
    if (address.toLowerCase().endsWith(want)) return { devSalt, address, tries: i + 1 };
  }
  throw new Error(`no address ending in ${want} after ${maxTries} tries`);
}
