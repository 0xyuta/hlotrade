// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title HLO, the mining token
/// @notice Minted only by Mining (claims) and Buyback (the one pool mint).
///         Supply never exceeds 5M; burned HLO frees room under the cap.
///         Transfers INTO the HLO/USDC pair are blocked until Buyback opens
///         the pool, so nobody can set the starting price before it does.
contract HloToken {
    string public constant name = "HLO";
    string public constant symbol = "HLO";
    uint8 public constant decimals = 18;
    uint256 public constant MAX_SUPPLY = 5_000_000e18;

    uint256 public totalSupply;
    uint256 public totalBurned;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable deployer;
    address public mining;
    address public buyback;
    address public lockedPair;
    bool public pairOpen;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotDeployer();
    error AlreadySet();
    error ZeroAddress();
    error NotMinter();
    error NotBuyback();
    error CapExceeded();
    error PairLocked();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-shot wiring done by the deploy script.
    function setMinters(address mining_, address buyback_, address pair_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (mining != address(0)) revert AlreadySet();
        if (mining_ == address(0) || buyback_ == address(0) || pair_ == address(0)) revert ZeroAddress();
        mining = mining_;
        buyback = buyback_;
        lockedPair = pair_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != mining && msg.sender != buyback) revert NotMinter();
        if (totalSupply + amount > MAX_SUPPLY) revert CapExceeded();
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external {
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] = bal - amount;
            totalSupply -= amount;
        }
        totalBurned += amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    /// @notice Buyback calls this once, when it opens the pool.
    function openPair() external {
        if (msg.sender != buyback) revert NotBuyback();
        pairOpen = true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = a - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == lockedPair && !pairOpen) revert PairLocked();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
