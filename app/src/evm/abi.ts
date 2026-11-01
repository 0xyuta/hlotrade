import { parseAbi } from "viem";

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

export const erc20Abi = parseAbi(ERC20);
export const tokenAbi = parseAbi([...ERC20, "function totalBurned() view returns (uint256)"]);
/** Checked against contracts/src/Checkpoints.sol (test/abi.test.ts). `settle` is anyone's to call with the poster's signed checkpoint. */
export const checkpointsAbi = parseAbi([
  "error IsPaused()",
  "error BadSignature()",
  "error NotNewer()",
  "error MinuteNotOver()",
  "error BadRefBlock()",
  "error ZeroRoot()",
  "error EntitlementDecreased()",
  "error OverSchedule()",
  "function latestMinute() view returns (uint256)",
  "function anySettled() view returns (bool)",
  "function anyValid() view returns (bool)",
  "function latestValidMinute() view returns (uint256)",
  "function launchTime() view returns (uint256)",
  "function VAULT_PERIOD() view returns (uint256)",
  "function poster() view returns (address)",
  "function paused() view returns (bool)",
  "function rootOf(uint256 m) view returns (bytes32)",
  "function settle((uint256 throughMinute, uint256 refBlock, bytes32 root, uint256 totalEntitled) cp, bytes sig)",
]);
/** Checked against contracts/src/Mining.sol (test/abi.test.ts). */
export const miningAbi = parseAbi([
  "error IsPaused()",
  "error NotSettled()",
  "error StaleCheckpoint()",
  "error BadProof()",
  "error NothingToClaim()",
  "error OverEntitled()",
  "error ClaimLimitReached()",
  "function claimAvailable() view returns (uint256)",
  "event Claimed(address indexed user, uint256 indexed throughMinute, uint256 claimedTotal, uint256 paid, uint256 refined)",
  "function claim(uint256 throughMinute, uint256 entitlement, bytes32[] proof) returns (uint256)",
  "function settleAndClaim((uint256 throughMinute, uint256 refBlock, bytes32 root, uint256 totalEntitled) cp, bytes sig, uint256 entitlement, bytes32[] proof) returns (uint256)",
  "function claimed(address user) view returns (uint256)",
]);
/**
 * The ABI for the settleAndClaim write: Mining's plus Checkpoints' errors (settleAndClaim settles first, so it can revert with either).
 * With them viem names the revert (NotNewer, MinuteNotOver, BadRefBlock…) and hl/errors.ts says it in plain words. Same-named errors (IsPaused) once.
 */
export const settleAndClaimAbi = [
  ...miningAbi,
  ...checkpointsAbi.filter((x) => x.type === "error" && !miningAbi.some((m) => m.type === "error" && m.name === x.name)),
] as const;
/** Errors checked against contracts/src/Staking.sol (TransferFailed is SafeTransfer's: a short balance or allowance). */
export const stakingAbi = parseAbi([
  "error ZeroAmount()",
  "error InsufficientStake()",
  "error TransferFailed()",
  "function stake(uint256 amount)",
  "function unstake(uint256 amount)",
  "function claim() returns (uint256 amount)",
  "function pending(address u) view returns (uint256)",
  "function staked(address) view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function undripped() view returns (uint256)",
]);
/** Errors and events checked against contracts/src/Buyback.sol (BadFee is constructor-only, so it is left out). */
export const buybackAbi = parseAbi([
  "event Bought(uint256 usdcIn, uint256 hloOut, uint256 burned, uint256 toStakers)",
  "event Skipped(uint256 spot, uint256 twap)",
  "error PoolAlreadyOpen()",
  "error TooEarly()",
  "error NothingToSeed()",
  "error PoolNotOpen()",
  "error TooSoon()",
  "error TransferFailed()",
  "function launchTime() view returns (uint256)",
  "function OPEN_DELAY() view returns (uint256)",
  "function BUY_INTERVAL() view returns (uint256)",
  "function poolOpen() view returns (bool)",
  "function slice() view returns (uint256)",
  "function lastBuy() view returns (uint256)",
  "function usdc() view returns (address)",
  "function hloIsToken0() view returns (bool)",
  "function totalSpent() view returns (uint256)",
  "function totalBought() view returns (uint256)",
  "function openPool()",
  "function buy() returns (uint256 bought)",
]);
export const pairAbi = parseAbi(["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"]);
/** The three errors are in Profiles.sol; with them in the ABI, viem decodes a revert into ContractFunctionRevertedError. */
export const profilesAbi = parseAbi([
  "error BadName()",
  "error NameTaken()",
  "error BadAvatar()",
  "function setName(string name)",
  "function setAvatar(uint8 id)",
  "function nameOf(address) view returns (string)",
  "function avatarOf(address) view returns (uint8)",
  "function ownerOfName(bytes32) view returns (address)",
]);
/** [R §4.2] CoreDepositWallet.deposit(uint256 amount, uint32 destinationDex). */
export const coreDepositWalletAbi = parseAbi(["function deposit(uint256 amount, uint32 destinationDex)"]);
/** [R §5.3 item 6, §6.3] TokenMessengerV2.depositForBurnWithHook. */
export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);
