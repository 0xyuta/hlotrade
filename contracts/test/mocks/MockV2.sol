// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IBal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice A Solidity 0.8 port of the parts of UniswapV2Pair that Buyback uses:
///         mint, swap (0.3% fee), sync, reserves, cumulative prices.
contract MockV2Pair {
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    function initialize(address t0, address t1) external {
        token0 = t0;
        token1 = t1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function _update(uint256 b0, uint256 b1, uint112 r0, uint112 r1) private {
        require(b0 <= type(uint112).max && b1 <= type(uint112).max, "OVERFLOW");
        uint32 ts = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = ts - blockTimestampLast;
            if (elapsed > 0 && r0 != 0 && r1 != 0) {
                // UQ112x112 encode-then-divide, then scale by elapsed: exactly as UniswapV2Pair does it.
                // forge-lint: disable-next-line(divide-before-multiply)
                price0CumulativeLast += ((uint256(r1) << 112) / r0) * elapsed;
                // forge-lint: disable-next-line(divide-before-multiply)
                price1CumulativeLast += ((uint256(r0) << 112) / r1) * elapsed;
            }
        }
        // casts are safe: both balances were checked against uint112 max by the OVERFLOW require above
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve0 = uint112(b0);
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve1 = uint112(b1);
        blockTimestampLast = ts;
    }

    function mint(address to) external returns (uint256 liquidity) {
        (uint112 r0, uint112 r1) = (reserve0, reserve1);
        uint256 b0 = IBal(token0).balanceOf(address(this));
        uint256 b1 = IBal(token1).balanceOf(address(this));
        uint256 a0 = b0 - r0;
        uint256 a1 = b1 - r1;
        if (totalSupply == 0) {
            liquidity = _sqrt(a0 * a1) - MINIMUM_LIQUIDITY;
            totalSupply = MINIMUM_LIQUIDITY;
            balanceOf[address(0)] = MINIMUM_LIQUIDITY;
        } else {
            uint256 l0 = a0 * totalSupply / r0;
            uint256 l1 = a1 * totalSupply / r1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        require(liquidity > 0, "LIQ");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        _update(b0, b1, r0, r1);
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        require(out0 > 0 || out1 > 0, "OUT");
        (uint112 r0, uint112 r1) = (reserve0, reserve1);
        require(out0 < r0 && out1 < r1, "RES");
        if (out0 > 0) require(IBal(token0).transfer(to, out0), "TRANSFER");
        if (out1 > 0) require(IBal(token1).transfer(to, out1), "TRANSFER");
        uint256 b0 = IBal(token0).balanceOf(address(this));
        uint256 b1 = IBal(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - out0 ? b0 - (r0 - out0) : 0;
        uint256 in1 = b1 > r1 - out1 ? b1 - (r1 - out1) : 0;
        require(in0 > 0 || in1 > 0, "IN");
        uint256 adj0 = b0 * 1000 - in0 * 3;
        uint256 adj1 = b1 * 1000 - in1 * 3;
        require(adj0 * adj1 >= uint256(r0) * uint256(r1) * 1_000_000, "K");
        _update(b0, b1, r0, r1);
    }

    function sync() external {
        _update(IBal(token0).balanceOf(address(this)), IBal(token1).balanceOf(address(this)), reserve0, reserve1);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address p) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        p = address(new MockV2Pair());
        MockV2Pair(p).initialize(t0, t1);
        getPair[a][b] = p;
        getPair[b][a] = p;
    }
}
