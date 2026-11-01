// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-20 transfers that accept tokens returning nothing or `true`.
library SafeTransfer {
    error TransferFailed();

    function transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function transferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
