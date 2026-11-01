// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IRefinedTotal {
    function totalRefined() external view returns (uint256);
}

interface IBurnedTotal {
    function totalBurned() external view returns (uint256);
}

/// @title Checkpoints: signed, cumulative HLO entitlements that anyone can settle
/// @notice The poster signs one checkpoint per minute off-chain (EIP-712). Anyone submits one with settle(), and it
///         is final at once. A checkpoint can never hand out more than the schedule allows (1.1 HLO per minute since
///         launch, within supply room) plus the refining recorded by Mining, so a bad one can only move HLO between
///         users, never create extra. The guardian can pause settling (Mining also stops claims), replace the poster and
///         the pauser, and, while paused, cancel settled checkpoints and record a write-off (recovery, spec 2026-10-30).
///         The pauser can only pause.
contract Checkpoints {
    uint256 public constant EMISSION_PER_MINUTE = 1.1e18;
    uint256 public constant MAX_SUPPLY = 5_000_000e18;
    uint256 public constant POOL_RESERVE = 10_000e18;
    bytes32 public constant CHECKPOINT_TYPEHASH =
        keccak256("Checkpoint(uint256 throughMinute,uint256 refBlock,bytes32 root,uint256 totalEntitled)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("HLO Checkpoints");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// secp256k1n / 2: signatures with a larger s are the malleable twin and are rejected.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Checkpoint {
        uint256 throughMinute;
        uint256 refBlock;
        bytes32 root;
        uint256 totalEntitled;
    }

    struct Stored {
        bytes32 root;
        uint256 totalEntitled;
        uint64 refBlock;
        uint64 settledAt;
    }

    IBurnedTotal public immutable token;
    uint256 public immutable launchTime;
    /// @notice Seconds per weekly-vault period (the calculator reads it; 7 days on mainnet).
    uint256 public immutable VAULT_PERIOD;
    address public immutable deployer;

    IRefinedTotal public mining;
    address public poster;
    address public guardian;
    bool public paused;
    bool public anySettled;
    uint256 public latestMinute;
    /// @notice Pause-only role (the verifier's key). Zero means none.
    address public pauser;
    /// @notice True while some settled checkpoint is not cancelled.
    bool public anyValid;
    /// @notice The newest settled minute that is not cancelled (meaningful only while anyValid).
    uint256 public latestValidMinute;
    /// @notice Gross HLO the guardian wrote off after an incident; Mining's overall bound allows this much more.
    uint256 public writtenOff;
    /// @notice Every address that has been the poster (the verifier accepts their files; settle accepts only the current one).
    mapping(address => bool) public wasPoster;

    struct Range {
        uint64 from;
        uint64 to;
    }

    /// Cancelled minute ranges, inclusive. One per incident, so the views loop over it.
    Range[] internal _cancelled;

    mapping(uint256 => Stored) internal _settled;

    event Settled(uint256 indexed throughMinute, uint256 refBlock, bytes32 root, uint256 totalEntitled);
    event PosterSet(address poster);
    event GuardianSet(address guardian);
    event PausedSet(bool paused);
    event PauserSet(address pauser);
    event Cancelled(uint256 fromMinute, uint256 toMinute);
    event WrittenOff(uint256 amount, uint256 total);

    error NotDeployer();
    error AlreadySet();
    error NotGuardian();
    error IsPaused();
    error ZeroAddress();
    error BadPeriod();
    error BadSignature();
    error NotNewer();
    error MinuteNotOver();
    error BadRefBlock();
    error ZeroRoot();
    error EntitlementDecreased();
    error OverSchedule();
    error NotPauser();
    error NotPaused();
    error BadKeep();
    error NothingSettled();
    error ZeroAmount();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier whilePaused() {
        if (!paused) revert NotPaused();
        _;
    }

    constructor(address token_, address poster_, address guardian_, address pauser_, uint256 vaultPeriod_) {
        if (token_ == address(0) || poster_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (vaultPeriod_ == 0 || vaultPeriod_ % 60 != 0) revert BadPeriod();
        token = IBurnedTotal(token_);
        poster = poster_;
        wasPoster[poster_] = true;
        guardian = guardian_;
        pauser = pauser_;
        deployer = msg.sender;
        launchTime = block.timestamp;
        VAULT_PERIOD = vaultPeriod_;
        emit PosterSet(poster_);
        emit GuardianSet(guardian_);
        emit PauserSet(pauser_);
    }

    function setMining(address mining_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(mining) != address(0)) revert AlreadySet();
        if (mining_ == address(0)) revert ZeroAddress();
        mining = IRefinedTotal(mining_);
    }

    // ------------------------------------------------------------------ settle

    /// @notice Anyone may submit a checkpoint the poster signed. It is final at once.
    function settle(Checkpoint calldata cp, bytes calldata sig) external {
        if (paused) revert IsPaused();
        // latestMinute is the highest minute ever settled, cancelled or not: a cancelled minute can never be settled again.
        if (anySettled && cp.throughMinute <= latestMinute) revert NotNewer();
        if (launchTime + 60 * (cp.throughMinute + 1) > block.timestamp) revert MinuteNotOver();
        // Order and totals compare with the newest checkpoint that is not cancelled.
        Stored storage last = _settled[latestValidMinute];
        if (cp.refBlock >= block.number || (anyValid && cp.refBlock < last.refBlock)) revert BadRefBlock();
        if (cp.root == bytes32(0)) revert ZeroRoot();
        if (anyValid && cp.totalEntitled < last.totalEntitled) revert EntitlementDecreased();
        if (cp.totalEntitled > emissionAllowedThrough(cp.throughMinute) + mining.totalRefined()) revert OverSchedule();
        if (_signer(cp, sig) != poster) revert BadSignature();
        _settled[cp.throughMinute] = Stored(cp.root, cp.totalEntitled, uint64(cp.refBlock), uint64(block.timestamp));
        latestMinute = cp.throughMinute;
        latestValidMinute = cp.throughMinute;
        anySettled = true;
        anyValid = true;
        emit Settled(cp.throughMinute, cp.refBlock, cp.root, cp.totalEntitled);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashCheckpoint(Checkpoint calldata cp) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(CHECKPOINT_TYPEHASH, cp.throughMinute, cp.refBlock, cp.root, cp.totalEntitled));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _signer(Checkpoint calldata cp, bytes calldata sig) internal view returns (address a) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N) revert BadSignature();
        a = ecrecover(hashCheckpoint(cp), v, r, s);
        if (a == address(0)) revert BadSignature();
    }

    // --------------------------------------------------------------- guardian

    function setPaused(bool p) external onlyGuardian {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice The pauser or the guardian stops settling (and Mining stops claims). Only the guardian unpauses.
    function pause() external {
        if (msg.sender != pauser && msg.sender != guardian) revert NotPauser();
        paused = true;
        emit PausedSet(true);
    }

    function setPoster(address p) external onlyGuardian {
        if (p == address(0)) revert ZeroAddress();
        poster = p;
        wasPoster[p] = true;
        emit PosterSet(p);
    }

    /// @notice Zero removes the pauser.
    function setPauser(address p) external onlyGuardian {
        pauser = p;
        emit PauserSet(p);
    }

    function setGuardian(address g) external onlyGuardian {
        if (g == address(0)) revert ZeroAddress();
        guardian = g;
        emit GuardianSet(g);
    }

    /// @notice Recovery (spec §2): cancels every settled minute after `keep`, which must be a settled minute that is not
    ///         cancelled, with something live after it. A cancelled minute reads as unsettled and can't be settled again.
    function cancelAfter(uint256 keep) external onlyGuardian whilePaused {
        if (!anyValid || keep > latestValidMinute || keep >= latestMinute || !isSettled(keep)) revert BadKeep();
        if (keep == latestValidMinute && isCancelled(latestMinute)) revert BadKeep();
        _cancelled.push(Range(uint64(keep + 1), uint64(latestMinute)));
        latestValidMinute = keep;
        emit Cancelled(keep + 1, latestMinute);
    }

    /// @notice Recovery when no settled checkpoint is good: cancels every settled minute. Needs a live (settled, not
    ///         cancelled) minute, so each new range needs a newly settled one and the range list stays short.
    function cancelAll() external onlyGuardian whilePaused {
        if (!anyValid) revert NothingSettled();
        _cancelled.push(Range(0, uint64(latestMinute)));
        anyValid = false;
        latestValidMinute = 0;
        emit Cancelled(0, latestMinute);
    }

    /// @notice Records gross HLO claimed against cancelled checkpoints beyond honest entitlements (the recovery report sums it).
    function writeOff(uint256 amount) external onlyGuardian whilePaused {
        if (amount == 0) revert ZeroAmount();
        writtenOff += amount;
        emit WrittenOff(amount, writtenOff);
    }

    // ------------------------------------------------------------------ views

    /// @notice Most HLO the schedule allows through the end of minute `m`: 1.1 per minute since launch, limited by
    ///         the supply room left after the pool reserve (burns free room).
    function emissionAllowedThrough(uint256 m) public view returns (uint256) {
        uint256 e = (m + 1) * EMISSION_PER_MINUTE;
        uint256 room = MAX_SUPPLY - POOL_RESERVE + token.totalBurned();
        return e < room ? e : room;
    }

    function isCancelled(uint256 m) public view returns (bool) {
        for (uint256 i = 0; i < _cancelled.length; i++) {
            if (m >= _cancelled[i].from && m <= _cancelled[i].to) return true;
        }
        return false;
    }

    function cancelledCount() external view returns (uint256) {
        return _cancelled.length;
    }

    function cancelledAt(uint256 i) external view returns (uint256 fromMinute, uint256 toMinute) {
        Range memory r = _cancelled[i];
        return (r.from, r.to);
    }

    /// A cancelled minute reads as never settled.
    function _live(uint256 m) internal view returns (Stored memory s) {
        if (!isCancelled(m)) s = _settled[m];
    }

    function isSettled(uint256 m) public view returns (bool) {
        return _live(m).root != bytes32(0);
    }

    function rootOf(uint256 m) external view returns (bytes32) {
        return _live(m).root;
    }

    function totalEntitledOf(uint256 m) external view returns (uint256) {
        return _live(m).totalEntitled;
    }

    function getCheckpoint(uint256 m) external view returns (Stored memory) {
        return _live(m);
    }
}
