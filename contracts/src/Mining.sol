// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleProof} from "./lib/MerkleProof.sol";
import {Checkpoints} from "./Checkpoints.sol";

interface IHloMint {
    function mint(address to, uint256 amount) external;
}

/// @title Mining: claims against Checkpoints' settled roots
/// @notice A root holds each user's CUMULATIVE entitlement. A claim mints 90% of
///         what is new since the user's last claim. The other 10% is refining:
///         the off-chain calculator shares it among unclaimed holders in later
///         checkpoints, and Checkpoints lets later ones include it (totalRefined).
///         Claims stop while Checkpoints is paused.
///
///         Claims are paid from one global allowance (a token bucket): at most
///         CLAIM_CAP of gross at once, refilled at CLAIM_PER_HOUR. A claim larger
///         than the allowance is paid in part (claimed[user] grows by what was paid
///         out, so the rest stays claimable); an empty allowance reverts
///         ClaimLimitReached. A leaked poster key can therefore assign everyone's
///         HLO to one wallet but cannot move it out faster than the allowance.
///
///         Only the user can claim: directly with claim(), or by signing an
///         EIP-712 Claim message that anyone (e.g. a gas-paying helper) submits
///         through claimFor(). If anyone could claim for anyone, a holder with a
///         large unclaimed balance could keep claiming everyone else's HLO and
///         take nearly all of the refining.
contract Mining {
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address user,uint256 entitlement,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("HLO Mining");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// secp256k1n / 2: signatures with a larger s are the malleable twin and are rejected.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    IHloMint public immutable token;
    Checkpoints public immutable checkpoints;
    /// @notice Most gross HLO (paid + refined) the allowance can hold, and so the most one claim can take.
    uint256 public immutable CLAIM_CAP;
    /// @notice Gross HLO the allowance gains per hour, linearly.
    uint256 public immutable CLAIM_PER_HOUR;

    mapping(address => uint256) public claimed;
    uint256 public totalRefined;
    uint256 public totalPaid;
    /// @notice Sum of every claim's gross (paid + refined). Never exceeds
    ///         maxEntitledBound.
    uint256 public totalClaimedGross;
    /// @notice Largest `totalEntitled` of any settled checkpoint a claim has been made
    ///         against. Checkpoint totals never decrease, so a claim against an older
    ///         (smaller) checkpoint after claims against a newer one is still bounded by
    ///         the newest total seen, not by its own checkpoint's.
    uint256 public maxEntitledBound;
    /// @notice The allowance as of `bucketUpdatedAt`; claimAvailable() adds the refill since.
    uint256 public claimBucket;
    uint256 public bucketUpdatedAt;

    /// @param claimedTotal The user's new claimed[user] (their cumulative claimed gross).
    event Claimed(
        address indexed user, uint256 indexed throughMinute, uint256 claimedTotal, uint256 paid, uint256 refined
    );

    error IsPaused();
    error NotSettled();
    error StaleCheckpoint();
    error BadProof();
    error NothingToClaim();
    error OverEntitled();
    error Expired();
    error BadSignature();
    error ClaimLimitReached();
    error ZeroLimit();

    constructor(address token_, address checkpoints_, uint256 claimCap_, uint256 claimPerHour_) {
        if (claimCap_ == 0 || claimPerHour_ == 0) revert ZeroLimit();
        token = IHloMint(token_);
        checkpoints = Checkpoints(checkpoints_);
        CLAIM_CAP = claimCap_;
        CLAIM_PER_HOUR = claimPerHour_;
        claimBucket = claimCap_;
        bucketUpdatedAt = block.timestamp;
    }

    /// @notice Gross HLO the next claim can take: the bucket plus the linear refill since the last claim, at most CLAIM_CAP.
    function claimAvailable() public view returns (uint256) {
        uint256 b = claimBucket + (block.timestamp - bucketUpdatedAt) * CLAIM_PER_HOUR / 1 hours;
        return b > CLAIM_CAP ? CLAIM_CAP : b;
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice Claims for msg.sender.
    function claim(uint256 throughMinute, uint256 entitlement, bytes32[] calldata proof) external returns (uint256) {
        return _claim(msg.sender, throughMinute, entitlement, proof);
    }

    /// @notice Settles `cp` if it is newer than the latest settled checkpoint, then claims for msg.sender against it.
    ///         If `cp` is not newer it must be the checkpoint already settled at its minute (someone settled it first).
    ///         If a newer checkpoint lands first, the call reverts StaleCheckpoint and the user can claim against the
    ///         newest settled checkpoint instead.
    function settleAndClaim(
        Checkpoints.Checkpoint calldata cp,
        bytes calldata sig,
        uint256 entitlement,
        bytes32[] calldata proof
    ) external returns (uint256) {
        if (!checkpoints.anySettled() || cp.throughMinute > checkpoints.latestMinute()) {
            checkpoints.settle(cp, sig);
        } else if (checkpoints.rootOf(cp.throughMinute) != cp.root) {
            revert StaleCheckpoint();
        }
        return _claim(msg.sender, cp.throughMinute, entitlement, proof);
    }

    /// @notice Anyone may submit a claim that `user` signed (EIP-712
    ///         `Claim(address user,uint256 entitlement,uint256 deadline)`); the
    ///         HLO goes to `user`. There is no nonce: replaying a used signature
    ///         claims at most the rest of the entitlement the user signed (nothing
    ///         once claimed[user] reaches it: NothingToClaim), and a signature never
    ///         lets anyone claim beyond the entitlement the user chose.
    function claimFor(
        address user,
        uint256 throughMinute,
        uint256 entitlement,
        bytes32[] calldata proof,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        _checkSignature(user, entitlement, deadline, v, r, s);
        return _claim(user, throughMinute, entitlement, proof);
    }

    function _checkSignature(address user, uint256 entitlement, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        internal
        view
    {
        if (block.timestamp > deadline) revert Expired();
        if (uint256(s) > HALF_N) revert BadSignature();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(CLAIM_TYPEHASH, user, entitlement, deadline))
            )
        );
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != user) revert BadSignature();
    }

    function _claim(address user, uint256 throughMinute, uint256 entitlement, bytes32[] calldata proof)
        internal
        returns (uint256 paid)
    {
        if (checkpoints.paused()) revert IsPaused();
        {
            bytes32 root = checkpoints.rootOf(throughMinute);
            if (root == bytes32(0)) revert NotSettled();
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user, entitlement))));
            if (!MerkleProof.verify(proof, root, leaf)) revert BadProof();
        }
        uint256 prev = claimed[user];
        if (entitlement <= prev) revert NothingToClaim();
        uint256 gross;
        {
            uint256 avail = claimAvailable();
            if (avail == 0) revert ClaimLimitReached();
            uint256 owed = entitlement - prev;
            gross = owed < avail ? owed : avail;
            claimBucket = avail - gross;
            bucketUpdatedAt = block.timestamp;
        }
        {
            // Checkpoints does not bind the total to the leaves, so bind it here. After a recovery the guardian's write-off
            // (HLO claimed against cancelled checkpoints) is allowed on top, so it never blocks the last honest claims.
            uint256 cpTotal = checkpoints.totalEntitledOf(throughMinute);
            if (cpTotal > maxEntitledBound) maxEntitledBound = cpTotal;
            uint256 newTotal = totalClaimedGross + gross;
            if (newTotal > maxEntitledBound + checkpoints.writtenOff()) revert OverEntitled();
            totalClaimedGross = newTotal;
        }
        uint256 claimedTotal = prev + gross;
        claimed[user] = claimedTotal;
        paid = gross * 9 / 10;
        uint256 refined = gross - paid;
        totalRefined += refined;
        totalPaid += paid;
        token.mint(user, paid);
        emit Claimed(user, throughMinute, claimedTotal, paid, refined);
    }
}
