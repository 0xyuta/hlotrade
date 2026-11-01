// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransfer} from "./lib/SafeTransfer.sol";

interface ISliceRefresh {
    function refreshSlice() external;
}

/// @title Splitter: 10% of fee USDC to the admin, 90% to Buyback
/// @notice The fee forwarder deposits each day's builder fees here. Rounding
///         goes to Buyback.
contract Splitter {
    address public immutable usdc;
    address public immutable buyback;
    address public admin;
    uint256 public adminBalance;
    uint256 public totalDeposited;

    event Deposited(address indexed from, uint256 amount, uint256 toAdmin, uint256 toBuyback);
    event AdminClaimed(address indexed admin, uint256 amount);
    event AdminSet(address admin);

    error ZeroAmount();
    error NotAdmin();
    error ZeroAddress();

    constructor(address usdc_, address buyback_, address admin_) {
        if (usdc_ == address(0) || buyback_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        buyback = buyback_;
        admin = admin_;
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        SafeTransfer.transferFrom(usdc, msg.sender, address(this), amount);
        uint256 toAdmin = amount / 10;
        uint256 toBuyback = amount - toAdmin;
        adminBalance += toAdmin;
        totalDeposited += amount;
        SafeTransfer.transfer(usdc, buyback, toBuyback);
        ISliceRefresh(buyback).refreshSlice();
        emit Deposited(msg.sender, amount, toAdmin, toBuyback);
    }

    function claimAdmin() external returns (uint256 amount) {
        if (msg.sender != admin) revert NotAdmin();
        amount = adminBalance;
        adminBalance = 0;
        if (amount != 0) SafeTransfer.transfer(usdc, admin, amount);
        emit AdminClaimed(admin, amount);
    }

    function setAdmin(address a) external {
        if (msg.sender != admin) revert NotAdmin();
        if (a == address(0)) revert ZeroAddress();
        admin = a;
        emit AdminSet(a);
    }
}
