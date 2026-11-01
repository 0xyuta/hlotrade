// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IUniswapV2Factory {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function mint(address to) external returns (uint256 liquidity);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function sync() external;
}
