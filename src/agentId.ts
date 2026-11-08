// The SPACE ID Agent ID: the NFT whose holders form MurkFun's holder set (MurkFunHolderRoots.AGENT_NFT(), read on
// chain; the constants below are facts about the SPACE ID contract).
// Contract: HandleRegistry (OZ v5 ERC721 "SPACE ID Agent ID" / "AI", verified on Sourcify), deployed at block 127950748.
// - soulbound (transfers, approvals and burns revert with Soulbound()), at most one per address (AddressHasHandle());
// - tokenId = uint256(keccak256(handle)) and handleOf(holder) is public.
// It is minted through register(handle, deadline, signature) with a SPACE ID server signature, which the user gets by
// claiming an Agent ID in the Binance Agentic Wallet. MurkFun cannot mint it for anyone. Holders that claimed it this
// way are added to the holder set by its operator (no transaction from the holder).
import { keccak256, parseAbi, toBytes, type Address } from "viem";

export const AGENT_NFT: Address = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F"; // SPACE ID Agent ID (BSC)
export const AGENT_NFT_DEPLOY_BLOCK = 127_950_748; // deploy tx 0xf576a1b7…7a33 (Sourcify; eth_getCode bisection)
export const AGENT_NFT_NAME = "SPACE ID Agent ID";

export const agentNftAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function handleOf(address) view returns (string)",
]);

/** The token id SPACE ID gives `handle` (the part before ".ai"). */
export const agentIdOf = (handle: string) => BigInt(keccak256(toBytes(handle)));

export function noAgentIdMessage(wallet: Address) {
  return `NO_AGENT_NFT: wallet ${wallet} holds no SPACE ID Agent ID. MurkFun requires one: its holders are the only wallets that can sign MurkFun orders, and MurkFun cannot mint it for you. ` +
    "Get it through a Binance Agentic Wallet: in the Binance App open Wallet → AI agent / Agent ID and claim an Agent ID (an .ai name, one per wallet, free apart from the BNB network fee). " +
    "Then use that agent wallet here (setup {signer:\"baw\"} with the Binance Agentic Wallet CLI `baw`).";
}
