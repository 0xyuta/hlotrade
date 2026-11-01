// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {IUniswapV2Factory, IUniswapV2Pair} from "./interfaces/IUniswapV2.sol";

interface IHloBuyback {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function openPair() external;
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IBalanceOf {
    function balanceOf(address) external view returns (uint256);
}

interface IStakingRewards {
    function notifyReward(uint256 amount) external;
}

/// @title Buyback: turns fee USDC into burned and staked HLO
/// @notice Until the pool opens, USDC only collects here. openPool() (anyone,
///         once, 7 days after launch) mints 10,000 HLO and adds them with ALL
///         collected USDC to the HLO/USDC pair. The pool tokens stay in this
///         contract forever: no function moves them. After that, buy()
///         (anyone, every 10 minutes) spends one 1/144 slice behind a 30-minute
///         TWAP guard, burns 90% of the HLO and sends 10% to Staking.
contract Buyback {
    uint256 public constant POOL_HLO = 10_000e18;
    uint256 public constant OPEN_DELAY = 7 days;
    uint256 public constant BUY_INTERVAL = 10 minutes;
    uint256 public constant SLICES = 144;
    uint256 public constant TWAP_WINDOW = 30 minutes;
    uint256 public constant MAX_DEVIATION_BPS = 200;
    uint256 public constant BURN_BPS = 9_000;
    /// @notice A buy takes 0.1% less HLO than the v2 formula allows, so a
    ///         swapFeeBps set slightly below the pair's real fee cannot make
    ///         every swap fail the pair's K check. The HLO left behind stays
    ///         in the locked pool.
    uint256 public constant SAFETY_BPS = 10;
    uint256 private constant OBS = 8;

    struct Obs {
        uint64 time;
        uint256 cumulative;
    }

    IHloBuyback public immutable hlo;
    address public immutable usdc;
    IUniswapV2Pair public immutable pair;
    IStakingRewards public immutable staking;
    uint256 public immutable launchTime;
    uint256 public immutable swapFeeBps;
    bool public immutable hloIsToken0;

    bool public poolOpen;
    uint256 public slice;
    uint256 public lastBuy;
    uint256 public liquidity;
    uint256 public totalSpent;
    uint256 public totalBought;
    uint256 public totalBurned;
    uint256 public totalToStakers;

    Obs[OBS] internal _obs;
    uint256 public obsCount;
    uint256 public lastObsTime;

    event PoolOpened(uint256 hlo, uint256 usdc, uint256 liquidity);
    event Bought(uint256 usdcIn, uint256 hloOut, uint256 burned, uint256 toStakers);
    event Skipped(uint256 spot, uint256 twap);
    event SliceSet(uint256 slice);

    error BadFee();
    error PoolAlreadyOpen();
    error TooEarly();
    error NothingToSeed();
    error PoolNotOpen();
    error TooSoon();

    constructor(
        address hlo_,
        address usdc_,
        address factory_,
        address staking_,
        uint256 launchTime_,
        uint256 swapFeeBps_
    ) {
        if (swapFeeBps_ >= 10_000) revert BadFee();
        address p = IUniswapV2Factory(factory_).getPair(hlo_, usdc_);
        if (p == address(0)) p = IUniswapV2Factory(factory_).createPair(hlo_, usdc_);
        hlo = IHloBuyback(hlo_);
        usdc = usdc_;
        pair = IUniswapV2Pair(p);
        staking = IStakingRewards(staking_);
        launchTime = launchTime_;
        swapFeeBps = swapFeeBps_;
        hloIsToken0 = IUniswapV2Pair(p).token0() == hlo_;
    }

    /// @notice Raises the slice to 1/144 of the USDC held now (never lowers it).
    ///         Splitter calls it on every deposit; anyone may.
    function refreshSlice() public {
        uint256 s = IBalanceOf(usdc).balanceOf(address(this)) / SLICES;
        if (s > slice) slice = s; // only grows: nobody can shrink it by refreshing
        emit SliceSet(slice);
    }

    function openPool() external {
        if (poolOpen) revert PoolAlreadyOpen();
        if (block.timestamp < launchTime + OPEN_DELAY) revert TooEarly();
        uint256 u = IBalanceOf(usdc).balanceOf(address(this));
        if (u == 0) revert NothingToSeed();
        poolOpen = true;
        hlo.mint(address(pair), POOL_HLO);
        SafeTransfer.transfer(usdc, address(pair), u);
        hlo.openPair();
        liquidity = pair.mint(address(this));
        _observe();
        slice = 0; // the pre-open balance was just seeded; start fresh
        refreshSlice();
        emit PoolOpened(POOL_HLO, u, liquidity);
    }

    function buy() external returns (uint256 bought) {
        if (!poolOpen) revert PoolNotOpen();
        if (block.timestamp < lastBuy + BUY_INTERVAL) revert TooSoon();
        (bool haveTwap, uint256 twap) = _twap();
        _observe();

        uint256 bal = IBalanceOf(usdc).balanceOf(address(this));
        uint256 spend = (slice == 0 || slice > bal) ? bal : slice;
        if (spend == 0) return 0;

        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rHlo, uint256 rUsdc) = hloIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 spot = (rUsdc << 112) / rHlo;
        if (!haveTwap || _deviates(spot, twap)) {
            emit Skipped(spot, twap);
            return 0;
        }

        uint256 inWithFee = spend * (10_000 - swapFeeBps);
        bought = inWithFee * rHlo / (rUsdc * 10_000 + inWithFee);
        bought = bought * (10_000 - SAFETY_BPS) / 10_000;
        if (bought == 0) return 0;

        lastBuy = block.timestamp; // only a buy that executes uses the interval
        _swapAndDistribute(spend, bought);
    }

    /// Sends `spend` USDC into the pair, takes `bought` HLO out, burns 90%
    /// and notifies Staking of the rest. Split out of buy() for stack depth.
    function _swapAndDistribute(uint256 spend, uint256 bought) internal {
        SafeTransfer.transfer(usdc, address(pair), spend);
        (uint256 out0, uint256 out1) = hloIsToken0 ? (bought, uint256(0)) : (uint256(0), bought);
        pair.swap(out0, out1, address(this), "");

        uint256 burned = bought * BURN_BPS / 10_000;
        uint256 toStakers = bought - burned;
        hlo.burn(burned);
        if (toStakers != 0) {
            hlo.approve(address(staking), toStakers);
            staking.notifyReward(toStakers);
        }
        totalSpent += spend;
        totalBought += bought;
        totalBurned += burned;
        totalToStakers += toStakers;
        emit Bought(spend, bought, burned, toStakers);
    }

    // ------------------------------------------------------------ price guard

    /// USDC per HLO as UQ112x112, accumulated over time (Uniswap v2 style).
    function _currentCumulative() internal view returns (uint256 cum) {
        (uint112 r0, uint112 r1, uint32 last) = pair.getReserves();
        cum = hloIsToken0 ? pair.price0CumulativeLast() : pair.price1CumulativeLast();
        unchecked {
            uint32 elapsed = uint32(block.timestamp) - last;
            if (elapsed != 0 && r0 != 0 && r1 != 0) {
                uint256 p = hloIsToken0 ? (uint256(r1) << 112) / r0 : (uint256(r0) << 112) / r1;
                cum += p * elapsed;
            }
        }
    }

    function _observe() internal {
        if (obsCount != 0 && block.timestamp < lastObsTime + BUY_INTERVAL) return;
        lastObsTime = block.timestamp;
        _obs[obsCount % OBS] = Obs(uint64(block.timestamp), _currentCumulative());
        obsCount++;
    }

    /// Average price since the newest stored observation that is at least
    /// TWAP_WINDOW old; false when none is that old yet.
    function _twap() internal view returns (bool, uint256) {
        uint256 n = obsCount < OBS ? obsCount : OBS;
        for (uint256 k; k < n; ++k) {
            Obs memory o = _obs[(obsCount - 1 - k) % OBS];
            uint256 age = block.timestamp - o.time;
            if (age >= TWAP_WINDOW) {
                uint256 cum = _currentCumulative();
                unchecked {
                    return (true, (cum - o.cumulative) / age);
                }
            }
        }
        return (false, 0);
    }

    function _deviates(uint256 spot, uint256 twap) internal pure returns (bool) {
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        return diff * 10_000 > twap * MAX_DEVIATION_BPS;
    }
}
