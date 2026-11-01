// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransfer} from "./lib/SafeTransfer.sol";

/// @title Staking: stake HLO, earn the stakers' 10% of buyback HLO
/// @notice No lock: stake and unstake at any time. Rewards arrive through
///         notifyReward (Buyback calls it; anyone may add) and drip to stakers
///         over time: each update releases undripped * min(elapsed, DRIP) / DRIP
///         to whoever is staked. A stake made just around a notifyReward therefore
///         earns (almost) nothing. While nobody is staked nothing is released;
///         the rewards stay undripped and reach later stakers gradually.
contract Staking {
    uint256 private constant ACC = 1e36;
    uint256 public constant DRIP = 1 days;

    address public immutable token;

    uint256 public totalStaked;
    uint256 public accPerShare;
    /// @notice Notified rewards not yet released to stakers.
    uint256 public undripped;
    uint256 public lastDrip;
    /// @notice Reward tokens held and not yet paid (released or undripped).
    ///         Invariant: token.balanceOf(this) == totalStaked + rewardBalance,
    ///         and rewardBalance >= undripped.
    uint256 public rewardBalance;
    mapping(address => uint256) public staked;
    mapping(address => uint256) internal _debt;
    mapping(address => uint256) internal _owed;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event RewardAdded(uint256 amount);
    event Dripped(uint256 released);

    error ZeroAmount();
    error InsufficientStake();

    constructor(address token_) {
        token = token_;
        lastDrip = block.timestamp;
    }

    function pending(address u) public view returns (uint256) {
        return _owed[u] + _scaled(staked[u], _accNow()) - _debt[u];
    }

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _drip();
        _settle(msg.sender);
        SafeTransfer.transferFrom(token, msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        _debt[msg.sender] = _scaled(staked[msg.sender], accPerShare);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (staked[msg.sender] < amount) revert InsufficientStake();
        _drip();
        _settle(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        _debt[msg.sender] = _scaled(staked[msg.sender], accPerShare);
        SafeTransfer.transfer(token, msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Pays owed rewards, capped at the released reward balance
    ///         (rewardBalance - undripped) so rounding can never reach principal
    ///         or rewards that have not dripped yet. Any unpaid remainder stays
    ///         in `_owed`.
    function claim() external returns (uint256 amount) {
        _drip();
        _settle(msg.sender);
        amount = _owed[msg.sender];
        uint256 released = rewardBalance - undripped;
        if (amount > released) amount = released;
        _owed[msg.sender] -= amount;
        rewardBalance -= amount;
        if (amount != 0) SafeTransfer.transfer(token, msg.sender, amount);
        emit RewardPaid(msg.sender, amount);
    }

    function notifyReward(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        SafeTransfer.transferFrom(token, msg.sender, address(this), amount);
        rewardBalance += amount;
        _drip();
        undripped += amount;
        emit RewardAdded(amount);
    }

    /// Releases the share of `undripped` due since lastDrip to current stakers.
    function _drip() internal {
        uint256 release = _releasable();
        if (release != 0) {
            undripped -= release;
            accPerShare += release * ACC / totalStaked;
            emit Dripped(release);
        }
        lastDrip = block.timestamp;
    }

    function _releasable() internal view returns (uint256) {
        if (totalStaked == 0) return 0;
        uint256 dt = block.timestamp - lastDrip;
        if (dt > DRIP) dt = DRIP;
        return undripped * dt / DRIP;
    }

    /// accPerShare as it would be after _drip() now.
    function _accNow() internal view returns (uint256 acc) {
        acc = accPerShare;
        uint256 release = _releasable();
        if (release != 0) acc += release * ACC / totalStaked;
    }

    /// Call only right after _drip(), so accPerShare is current.
    function _settle(address u) internal {
        _owed[u] = pending(u);
        _debt[u] = _scaled(staked[u], accPerShare);
    }

    /// @dev floor(s * acc / ACC) without a full-width product. acc can grow
    ///      large after a period with almost nothing staked, and then s * acc
    ///      would overflow for a large s. Splitting into whole and fractional
    ///      parts is exact: s*(q*ACC + r)/ACC = s*q + floor(s*r/ACC).
    function _scaled(uint256 s, uint256 acc) internal pure returns (uint256) {
        return s * (acc / ACC) + s * (acc % ACC) / ACC;
    }
}
