// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {HloToken} from "../src/HloToken.sol";
import {Checkpoints} from "../src/Checkpoints.sol";
import {Mining} from "../src/Mining.sol";
import {Staking} from "../src/Staking.sol";
import {Buyback} from "../src/Buyback.sol";
import {Splitter} from "../src/Splitter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockV2Factory} from "./mocks/MockV2.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

contract DeployTest is Test {
    Deploy deployer;
    Deploy.Deployed d;
    MockERC20 usdc;
    uint256 constant POSTER_PK = 0x9057E4;
    uint256 constant PERIOD = 1 hours;
    uint256 constant CAP = 5000 ether;
    uint256 constant PER_HOUR = 330 ether;
    address poster = vm.addr(POSTER_PK);
    address guardian = address(0x6A);
    address pauser = address(0x9A);
    address admin = address(0xAD);
    address alice = address(0xA11CE);
    Deploy.Roles roles = Deploy.Roles(poster, guardian, pauser, admin);

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        usdc = new MockERC20("USDC", 6);
        MockV2Factory factory = new MockV2Factory();
        deployer = new Deploy();
        d = deployer.deploy(address(usdc), address(factory), 30, roles, PERIOD, CAP, PER_HOUR);
    }

    function test_Wiring() public view {
        HloToken t = HloToken(d.token);
        assertEq(t.mining(), d.mining);
        assertEq(t.buyback(), d.buyback);
        assertEq(t.lockedPair(), d.pair);
        Checkpoints c = Checkpoints(d.checkpoints);
        assertEq(address(c.mining()), d.mining); // setMining ran
        assertEq(c.poster(), poster);
        assertEq(c.guardian(), guardian);
        assertEq(c.pauser(), pauser);
        assertEq(c.VAULT_PERIOD(), PERIOD);
        assertEq(address(Mining(d.mining).checkpoints()), d.checkpoints);
        assertEq(Mining(d.mining).CLAIM_CAP(), 5000 ether);
        assertEq(Mining(d.mining).CLAIM_PER_HOUR(), 330 ether);
        assertEq(Mining(d.mining).claimAvailable(), 5000 ether);
        assertEq(Staking(d.staking).token(), d.token);
        Buyback b = Buyback(d.buyback);
        assertEq(address(b.pair()), d.pair);
        assertEq(address(b.staking()), d.staking);
        assertEq(b.launchTime(), c.launchTime() + deployer.LAUNCH_MARGIN());
        assertGe(b.launchTime(), c.launchTime());
        assertLe(b.launchTime() - c.launchTime(), 1 hours);
        assertEq(Splitter(d.splitter).buyback(), d.buyback);
        assertEq(Splitter(d.splitter).admin(), admin);
    }

    /// One checkpoint settled and claimed, fees deposited, pool opened, one buy.
    function test_EndToEnd() public {
        Checkpoints c = Checkpoints(d.checkpoints);
        uint256 m = 9; // 10 minutes of schedule allow 11 HLO
        vm.warp(c.launchTime() + 60 * (m + 1));
        vm.roll(vm.getBlockNumber() + 1);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = MerkleHelper.leaf(alice, 10e18);
        (bytes32 root, bytes32[] memory proof) = MerkleHelper.rootAndProof(leaves, 0);
        Checkpoints.Checkpoint memory cp = Checkpoints.Checkpoint(m, block.number - 1, root, 10e18);
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(POSTER_PK, c.hashCheckpoint(cp));
        c.settle(cp, abi.encodePacked(r, sv, v)); // anyone may submit it
        vm.prank(alice);
        Mining(d.mining).claim(m, 10e18, proof);
        assertEq(HloToken(d.token).balanceOf(alice), 9e18);
        assertEq(Mining(d.mining).totalRefined(), 1e18);

        usdc.mint(address(this), 1000e6);
        usdc.approve(d.splitter, type(uint256).max);
        Splitter(d.splitter).deposit(1000e6);

        vm.warp(c.launchTime() + 7 days);
        vm.expectRevert(Buyback.TooEarly.selector); // the launch margin keeps the pool shut a little longer
        Buyback(d.buyback).openPool();
        vm.warp(Buyback(d.buyback).launchTime() + 7 days);
        Buyback(d.buyback).openPool();
        assertTrue(HloToken(d.token).pairOpen());

        usdc.mint(address(this), 1440e6);
        Splitter(d.splitter).deposit(1440e6);
        vm.warp(block.timestamp + 31 minutes);
        assertGt(Buyback(d.buyback).buy(), 0);
    }

    // ------------------------------------------------------------ I2: deploy guards

    function test_DeployRejectsNoCode() public {
        Deploy dep = new Deploy();
        MockV2Factory factory = new MockV2Factory();
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "NO_CODE"));
        dep.deploy(address(0xBEEF), address(factory), 30, roles, PERIOD, CAP, PER_HOUR); // usdc is an EOA
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "NO_CODE"));
        dep.deploy(address(usdc), address(0xBEEF), 30, roles, PERIOD, CAP, PER_HOUR); // factory is an EOA
    }

    function test_DeployRejectsNon6DecimalUsdc() public {
        Deploy dep = new Deploy();
        MockV2Factory factory = new MockV2Factory();
        MockERC20 usdc18 = new MockERC20("USDC", 18);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "USDC_DECIMALS"));
        dep.deploy(address(usdc18), address(factory), 30, roles, PERIOD, CAP, PER_HOUR);
        // a contract with no decimals() at all
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "USDC_DECIMALS"));
        dep.deploy(address(factory), address(factory), 30, roles, PERIOD, CAP, PER_HOUR);
    }

    /// On chain 999 the guardian must be a contract (the Safe) and the pauser a distinct, non-zero address.
    function _mainnetRoles() internal returns (Deploy.Roles memory) {
        address safe = address(new Splitter(address(usdc), address(1), address(2))); // any contract stands in for the Safe
        return Deploy.Roles(poster, safe, pauser, admin);
    }

    function test_mainnetNeedsASafeGuardianAndADistinctPauser() public {
        vm.chainId(999);
        Deploy dep = new Deploy();
        MockV2Factory factory = new MockV2Factory();
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "GUARDIAN_NOT_A_SAFE"));
        dep.deploy(address(usdc), address(factory), 30, roles, 7 days, CAP, PER_HOUR);
        address safe = address(new Splitter(address(usdc), address(1), address(2)));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "PAUSER"));
        dep.deploy(address(usdc), address(factory), 30, Deploy.Roles(poster, safe, address(0), admin), 7 days, CAP, PER_HOUR);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "PAUSER"));
        dep.deploy(address(usdc), address(factory), 30, Deploy.Roles(poster, safe, safe, admin), 7 days, CAP, PER_HOUR);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "PAUSER"));
        dep.deploy(address(usdc), address(factory), 30, Deploy.Roles(poster, safe, poster, admin), 7 days, CAP, PER_HOUR);
        Deploy.Deployed memory d2 =
            dep.deploy(address(usdc), address(factory), 30, Deploy.Roles(poster, safe, pauser, admin), 7 days, CAP, PER_HOUR);
        assertEq(Checkpoints(d2.checkpoints).pauser(), pauser);
        assertEq(Checkpoints(d2.checkpoints).guardian(), safe);
    }

    // ------------------------------------------------------------ vault period

    function test_VaultPeriodIsRequiredToBeSevenDaysOnMainnet() public {
        Deploy dep = new Deploy();
        MockV2Factory factory = new MockV2Factory();
        vm.chainId(999);
        Deploy.Roles memory mr = _mainnetRoles();
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "VAULT_PERIOD"));
        dep.deploy(address(usdc), address(factory), 30, mr, 1 hours, CAP, PER_HOUR);
        Deploy.Deployed memory m = dep.deploy(address(usdc), address(factory), 30, mr, 7 days, CAP, PER_HOUR);
        assertEq(Checkpoints(m.checkpoints).VAULT_PERIOD(), 7 days);
    }

    function test_VaultPeriodIsFreeOffMainnet() public {
        Deploy dep = new Deploy();
        MockV2Factory factory = new MockV2Factory();
        Deploy.Deployed memory m = dep.deploy(address(usdc), address(factory), 30, roles, 3600, CAP, PER_HOUR);
        assertEq(Checkpoints(m.checkpoints).VAULT_PERIOD(), 3600);
    }

    // ------------------------------------------------------------ claim-rate limit

    function test_ClaimLimitIsRequiredOnMainnet() public {
        Deploy dep = new Deploy();
        MockV2Factory factory = new MockV2Factory();
        vm.chainId(999);
        Deploy.Roles memory mr = _mainnetRoles();
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "CLAIM_LIMIT"));
        dep.deploy(address(usdc), address(factory), 30, mr, 7 days, 6000 ether, PER_HOUR);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "CLAIM_LIMIT"));
        dep.deploy(address(usdc), address(factory), 30, mr, 7 days, CAP, 331 ether);
        Deploy.Deployed memory m =
            dep.deploy(address(usdc), address(factory), 30, mr, 7 days, CAP, PER_HOUR);
        assertEq(Mining(m.mining).CLAIM_CAP(), CAP);
        assertEq(Mining(m.mining).CLAIM_PER_HOUR(), PER_HOUR);
    }

    function test_ClaimLimitIsFreeOffMainnet() public {
        Deploy dep = new Deploy();
        MockV2Factory factory = new MockV2Factory();
        Deploy.Deployed memory m =
            dep.deploy(address(usdc), address(factory), 30, roles, PERIOD, 100 ether, 10 ether);
        assertEq(Mining(m.mining).CLAIM_CAP(), 100 ether);
        assertEq(Mining(m.mining).CLAIM_PER_HOUR(), 10 ether);
    }
}
