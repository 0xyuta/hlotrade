// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HloToken} from "../src/HloToken.sol";
import {Checkpoints} from "../src/Checkpoints.sol";
import {Mining} from "../src/Mining.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

contract MiningTest is Test {
    HloToken token;
    Checkpoints checkpoints;
    Mining mining;
    uint256 constant ALICE_PK = 0xA11CE;
    uint256 constant BOB_PK = 0xB0B;
    uint256 constant POSTER_PK = 0x9057E5;
    address alice = vm.addr(ALICE_PK);
    address bob = vm.addr(BOB_PK);
    address poster = vm.addr(POSTER_PK);
    address guardian = address(0x6A);
    address pauser = address(0x9A);
    /// Two minutes far enough from launch that the schedule (1.1 HLO per minute) allows the amounts below.
    uint256 constant M0 = 1000;
    uint256 constant M1 = 2000;

    event Claimed(
        address indexed user, uint256 indexed throughMinute, uint256 claimedTotal, uint256 paid, uint256 refined
    );

    uint256 constant CAP = 5000e18;
    uint256 constant PER_HOUR = 330e18;
    /// Far enough from launch that the schedule allows the big amounts of the claim-rate-limit tests (about 11,000 HLO).
    uint256 constant M_BIG = 10_000;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        token = new HloToken();
        checkpoints = new Checkpoints(address(token), poster, guardian, pauser, 1 hours);
        mining = new Mining(address(token), address(checkpoints), CAP, PER_HOUR);
        checkpoints.setMining(address(mining));
        token.setMinters(address(mining), address(0xB1), address(0xFA1F));
    }

    function _leaves(uint256 a, uint256 b) internal view returns (bytes32[] memory l) {
        l = new bytes32[](2);
        l[0] = MerkleHelper.leaf(alice, a);
        l[1] = MerkleHelper.leaf(bob, b);
    }

    function _sign(uint256 pk, Checkpoints.Checkpoint memory cp) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, checkpoints.hashCheckpoint(cp));
        return abi.encodePacked(r, s, v);
    }

    /// Settles minute `m` with cumulative entitlements (a for alice, b for bob).
    function _settle(uint256 m, uint256 a, uint256 b) internal returns (bytes32 root) {
        return _settleWithTotal(m, a, b, a + b);
    }

    /// Same, but the settled `totalEntitled` is chosen independently of the leaves.
    function _settleWithTotal(uint256 m, uint256 a, uint256 b, uint256 total) internal returns (bytes32 root) {
        uint256 end = checkpoints.launchTime() + 60 * (m + 1);
        if (block.timestamp < end) vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
        (root,) = MerkleHelper.rootAndProof(_leaves(a, b), 0);
        Checkpoints.Checkpoint memory cp = Checkpoints.Checkpoint(m, block.number - 1, root, total);
        checkpoints.settle(cp, _sign(POSTER_PK, cp));
    }

    function _proof(uint256 a, uint256 b, uint256 idx) internal view returns (bytes32[] memory p) {
        (, p) = MerkleHelper.rootAndProof(_leaves(a, b), idx);
    }

    function _claimAs(address u, uint256 m, uint256 e, bytes32[] memory p) internal returns (uint256) {
        vm.prank(u);
        return mining.claim(m, e, p);
    }

    function test_ClaimPays90AndRefines10() public {
        _settle(M0, 100e18, 200e18);
        vm.expectEmit(true, true, false, true);
        emit Claimed(alice, M0, 100e18, 90e18, 10e18);
        uint256 paid = _claimAs(alice, M0, 100e18, _proof(100e18, 200e18, 0));
        assertEq(paid, 90e18);
        assertEq(token.balanceOf(alice), 90e18);
        assertEq(mining.claimed(alice), 100e18);
        assertEq(mining.totalRefined(), 10e18);
        assertEq(mining.totalPaid(), 90e18);
        assertEq(mining.totalClaimedGross(), 100e18);
    }

    function test_SecondClaimPaysOnlyTheDifference() public {
        _settle(M0, 100e18, 200e18);
        _claimAs(alice, M0, 100e18, _proof(100e18, 200e18, 0));
        _settle(M1, 150e18, 300e18);
        uint256 paid = _claimAs(alice, M1, 150e18, _proof(150e18, 300e18, 0));
        assertEq(paid, 45e18);
        assertEq(token.balanceOf(alice), 135e18);
        assertEq(mining.totalRefined(), 15e18);
    }

    function test_ClaimingSameMinuteTwiceReverts() public {
        _settle(M0, 100e18, 200e18);
        _claimAs(alice, M0, 100e18, _proof(100e18, 200e18, 0));
        vm.expectRevert(Mining.NothingToClaim.selector);
        _claimAs(alice, M0, 100e18, _proof(100e18, 200e18, 0));
    }

    function test_ClaimNotSettledReverts() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 0);
        vm.expectRevert(Mining.NotSettled.selector);
        _claimAs(alice, M0 - 1, 100e18, p);
    }

    function test_BadProofOrWrongUserReverts() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 0);
        vm.expectRevert(Mining.BadProof.selector);
        _claimAs(alice, M0, 101e18, p);
        vm.expectRevert(Mining.BadProof.selector);
        _claimAs(bob, M0, 100e18, p);
    }

    // ------------------------------------------------ C1: only the user claims

    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    address relayer = address(0xCAFE);

    /// claim() credits msg.sender only: a third party with bob's proof gets nothing
    /// and cannot touch bob's unclaimed balance.
    function test_ClaimCreditsSenderOnly() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        vm.prank(relayer);
        vm.expectRevert(Mining.BadProof.selector);
        mining.claim(M0, 200e18, p);
        assertEq(mining.claimed(bob), 0);
        assertEq(token.balanceOf(bob), 0);
        _claimAs(bob, M0, 200e18, p);
        assertEq(token.balanceOf(bob), 180e18);
        assertEq(token.balanceOf(relayer), 0);
    }

    function _digest(address user, uint256 entitlement, uint256 deadline) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("HLO Mining"),
                keccak256("1"),
                block.chainid,
                address(mining)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Claim(address user,uint256 entitlement,uint256 deadline)"), user, entitlement, deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 pk, address user, uint256 entitlement, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        (v, r, s) = vm.sign(pk, _digest(user, entitlement, deadline));
    }

    function test_DomainSeparatorMatchesEip712() public view {
        assertEq(
            mining.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("HLO Mining"),
                    keccak256("1"),
                    block.chainid,
                    address(mining)
                )
            )
        );
    }

    function test_ClaimForWithSignaturePaysUser() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 200e18, deadline);
        vm.expectEmit(true, true, false, true);
        emit Claimed(bob, M0, 200e18, 180e18, 20e18);
        vm.prank(relayer);
        uint256 paid = mining.claimFor(bob, M0, 200e18, p, deadline, v, r, s);
        assertEq(paid, 180e18);
        assertEq(token.balanceOf(bob), 180e18);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(mining.claimed(bob), 200e18);
    }

    function test_ClaimForWrongSignerReverts() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, bob, 200e18, deadline); // alice signs for bob
        vm.expectRevert(Mining.BadSignature.selector);
        mining.claimFor(bob, M0, 200e18, p, deadline, v, r, s);
        // a signature over a different entitlement does not match either
        (v, r, s) = _sign(BOB_PK, bob, 199e18, deadline);
        vm.expectRevert(Mining.BadSignature.selector);
        mining.claimFor(bob, M0, 200e18, p, deadline, v, r, s);
        assertEq(mining.claimed(bob), 0);
    }

    function test_ClaimForExpiredReverts() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        uint256 deadline = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 200e18, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(Mining.Expired.selector);
        mining.claimFor(bob, M0, 200e18, p, deadline, v, r, s);
    }

    function test_ClaimForAtDeadlineWorks() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        uint256 deadline = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 200e18, deadline);
        assertEq(mining.claimFor(bob, M0, 200e18, p, deadline, v, r, s), 180e18);
    }

    function test_ClaimForHighSReverts() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 200e18, deadline);
        // the malleable twin (n - s, flipped v) recovers the same signer
        bytes32 s2 = bytes32(SECP256K1_N - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        assertEq(ecrecover(_digest(bob, 200e18, deadline), v2, r, s2), bob);
        vm.expectRevert(Mining.BadSignature.selector);
        mining.claimFor(bob, M0, 200e18, p, deadline, v2, r, s2);
    }

    function test_ClaimForZeroRecoveryReverts() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        uint256 deadline = block.timestamp + 1 hours;
        // garbage signatures recover address(0); user = address(0) must not match it
        assertEq(ecrecover(_digest(address(0), 200e18, deadline), 27, bytes32(0), bytes32(0)), address(0));
        vm.expectRevert(Mining.BadSignature.selector);
        mining.claimFor(address(0), M0, 200e18, p, deadline, 27, bytes32(0), bytes32(0));
        // an invalid v also recovers address(0)
        (, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 200e18, deadline);
        vm.expectRevert(Mining.BadSignature.selector);
        mining.claimFor(bob, M0, 200e18, p, deadline, 29, r, s);
    }

    /// No nonce: replaying a used signature finds claimed[user] == entitlement.
    function test_ClaimForReplayNothingToClaim() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 200e18, deadline);
        mining.claimFor(bob, M0, 200e18, p, deadline, v, r, s);
        vm.expectRevert(Mining.NothingToClaim.selector);
        mining.claimFor(bob, M0, 200e18, p, deadline, v, r, s);
        assertEq(token.balanceOf(bob), 180e18);
    }

    /// A signature cannot be used against a proof for a different user.
    function test_ClaimForStillChecksProof() public {
        _settle(M0, 100e18, 200e18);
        bytes32[] memory p = _proof(100e18, 200e18, 0); // alice's proof
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 100e18, deadline);
        vm.expectRevert(Mining.BadProof.selector);
        mining.claimFor(bob, M0, 100e18, p, deadline, v, r, s);
    }

    function test_RefiningRaisesTheCheckpointCap() public {
        uint256 allowed = checkpoints.emissionAllowedThrough(M0);
        _settle(M0, allowed / 2, allowed / 2);
        _claimAs(alice, M0, allowed / 2, _proof(allowed / 2, allowed / 2, 0));
        uint256 refined = mining.totalRefined();
        assertGt(refined, 0);
        // a later checkpoint may hand out the schedule through its minute plus the refining
        uint256 next = checkpoints.emissionAllowedThrough(M1) + refined;
        _settle(M1, next - allowed / 2, allowed / 2);
        assertEq(checkpoints.totalEntitledOf(M1), next);
    }

    function testFuzz_PaidPlusRefinedEqualsGross(uint256 a) public {
        a = bound(a, 1, checkpoints.emissionAllowedThrough(M0) - 1);
        _settle(M0, a, 1);
        uint256 paid = _claimAs(alice, M0, a, _proof(a, 1, 0));
        assertEq(paid + mining.totalRefined(), a);
        assertGe(mining.totalRefined() * 10, a);
        assertEq(paid, a * 9 / 10);
        assertEq(mining.totalClaimedGross(), a);
    }

    /// Checkpoints never binds the settled total to the leaves; Mining must.
    function test_ClaimsCannotExceedSettledTotal() public {
        // leaves sum to 300e18 but the settled total is only 250e18
        _settleWithTotal(M0, 100e18, 200e18, 250e18);
        _claimAs(alice, M0, 100e18, _proof(100e18, 200e18, 0));
        assertEq(mining.totalClaimedGross(), 100e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        vm.expectRevert(Mining.OverEntitled.selector);
        _claimAs(bob, M0, 200e18, p);
    }

    // ------------------------------------------------ I3: older settled checkpoints stay claimable

    /// alice claims against the later checkpoint (bigger total); bob then claims his older,
    /// smaller leaf. Bounding by the older total alone would wrongly revert.
    function test_OlderCheckpointClaimAfterNewerCheckpointClaim() public {
        _settle(M0, 100e18, 200e18); // total 300
        bytes32[] memory bobOld = _proof(100e18, 200e18, 1);
        _settle(M1, 150e18, 300e18); // total 450
        _claimAs(alice, M1, 150e18, _proof(150e18, 300e18, 0));
        assertEq(mining.maxEntitledBound(), 450e18);
        uint256 paid = _claimAs(bob, M0, 200e18, bobOld);
        assertEq(paid, 180e18);
        assertEq(mining.totalClaimedGross(), 350e18);
        assertEq(mining.maxEntitledBound(), 450e18); // never lowered by an older checkpoint
    }

    /// The bound is the largest total of any checkpoint claimed against so far.
    function test_BoundStillCapsClaims() public {
        _settleWithTotal(M0, 100e18, 200e18, 250e18);
        _claimAs(alice, M0, 100e18, _proof(100e18, 200e18, 0));
        assertEq(mining.maxEntitledBound(), 250e18);
        bytes32[] memory p = _proof(100e18, 200e18, 1);
        vm.expectRevert(Mining.OverEntitled.selector);
        _claimAs(bob, M0, 200e18, p);
    }

    // ------------------------------------------------ settleAndClaim, pause

    function test_settleAndClaimSettlesThenClaimsInOneCall() public {
        vm.warp(checkpoints.launchTime() + 60 * 3);
        vm.roll(vm.getBlockNumber() + 1);
        bytes32[] memory leaves = _leaves(1e18, 2e18);
        (bytes32 root, bytes32[] memory proof) = MerkleHelper.rootAndProof(leaves, 0);
        Checkpoints.Checkpoint memory cp = Checkpoints.Checkpoint(2, block.number - 1, root, 3e18);
        bytes memory sig = _sign(POSTER_PK, cp);
        vm.prank(alice);
        uint256 paid = mining.settleAndClaim(cp, sig, 1e18, proof);
        assertEq(paid, 0.9e18);
        assertEq(checkpoints.latestMinute(), 2);
        assertEq(token.balanceOf(alice), 0.9e18);
    }

    function test_settleAndClaimOnAnAlreadySettledCheckpointJustClaims() public {
        bytes32 root = _settle(2, 1e18, 2e18);
        Checkpoints.Checkpoint memory cp = Checkpoints.Checkpoint(2, checkpoints.getCheckpoint(2).refBlock, root, 3e18);
        bytes32[] memory leaves = _leaves(1e18, 2e18);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(leaves, 1);
        vm.prank(bob);
        mining.settleAndClaim(cp, hex"", 2e18, proof);
        assertEq(token.balanceOf(bob), 1.8e18);
    }

    function test_settleAndClaimWithAStaleCheckpointReverts() public {
        _settle(5, 1e18, 2e18);
        Checkpoints.Checkpoint memory stale = Checkpoints.Checkpoint(4, 1, keccak256("x"), 3e18);
        vm.prank(alice);
        vm.expectRevert(Mining.StaleCheckpoint.selector);
        mining.settleAndClaim(stale, hex"", 1e18, new bytes32[](0));
    }

    function test_claimAgainstAnUnsettledMinuteReverts() public {
        _settle(5, 1e18, 2e18);
        vm.prank(alice);
        vm.expectRevert(Mining.NotSettled.selector);
        mining.claim(4, 1e18, new bytes32[](0));
    }

    function test_pauseStopsClaims() public {
        _settle(5, 1e18, 2e18);
        bytes32[] memory leaves = _leaves(1e18, 2e18);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(leaves, 0);
        vm.prank(guardian);
        checkpoints.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(Mining.IsPaused.selector);
        mining.claim(5, 1e18, proof);
        vm.prank(guardian);
        checkpoints.setPaused(false);
        vm.prank(alice);
        mining.claim(5, 1e18, proof);
    }

    function test_claimAgainstAnOlderSettledCheckpointStillWorks() public {
        _settle(5, 1e18, 2e18);
        _settle(9, 1.5e18, 2.5e18);
        bytes32[] memory leaves = _leaves(1e18, 2e18);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(leaves, 0);
        vm.prank(alice);
        mining.claim(5, 1e18, proof);
        assertEq(token.balanceOf(alice), 0.9e18);
        assertEq(mining.maxEntitledBound(), 3e18);
    }

    // ------------------------------------------------ settleAndClaim: every branch

    /// Moves time so minute m is over and builds (unsettled) checkpoint m for the two-leaf tree, signed by `pk`.
    function _newCp(uint256 m, uint256 a, uint256 b, uint256 pk)
        internal
        returns (Checkpoints.Checkpoint memory cp, bytes memory sig)
    {
        uint256 end = checkpoints.launchTime() + 60 * (m + 1);
        if (block.timestamp < end) vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
        (bytes32 root,) = MerkleHelper.rootAndProof(_leaves(a, b), 0);
        cp = Checkpoints.Checkpoint(m, block.number - 1, root, a + b);
        sig = _sign(pk, cp);
    }

    function test_settleAndClaimNewerThanLatestAfterASettle() public {
        _settle(5, 1e18, 2e18);
        (Checkpoints.Checkpoint memory cp, bytes memory sig) = _newCp(9, 1.5e18, 2.5e18, POSTER_PK);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(1.5e18, 2.5e18), 0);
        vm.prank(alice);
        uint256 paid = mining.settleAndClaim(cp, sig, 1.5e18, proof);
        assertEq(paid, 1.35e18);
        assertEq(token.balanceOf(alice), 1.35e18);
        assertEq(checkpoints.latestMinute(), 9);
        assertEq(checkpoints.rootOf(9), cp.root);
        assertEq(mining.claimed(alice), 1.5e18);
    }

    function test_settleAndClaimSameMinuteOtherRootIsStale() public {
        _settle(5, 1e18, 2e18);
        Checkpoints.Checkpoint memory other =
            Checkpoints.Checkpoint(5, checkpoints.getCheckpoint(5).refBlock, keccak256("other"), 3e18);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(1e18, 2e18), 0);
        vm.prank(alice);
        vm.expectRevert(Mining.StaleCheckpoint.selector);
        mining.settleAndClaim(other, hex"", 1e18, proof);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_settleAndClaimWhilePausedWithANewerCheckpointRevertsInCheckpoints() public {
        _settle(5, 1e18, 2e18);
        (Checkpoints.Checkpoint memory cp, bytes memory sig) = _newCp(9, 1.5e18, 2.5e18, POSTER_PK);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(1.5e18, 2.5e18), 0);
        vm.prank(guardian);
        checkpoints.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(Checkpoints.IsPaused.selector);
        mining.settleAndClaim(cp, sig, 1.5e18, proof);
        assertEq(checkpoints.latestMinute(), 5);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_settleAndClaimWhilePausedOnASettledCheckpointRevertsInMining() public {
        bytes32 root = _settle(5, 1e18, 2e18);
        Checkpoints.Checkpoint memory cp = Checkpoints.Checkpoint(5, checkpoints.getCheckpoint(5).refBlock, root, 3e18);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(1e18, 2e18), 0);
        vm.prank(guardian);
        checkpoints.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(Mining.IsPaused.selector);
        mining.settleAndClaim(cp, hex"", 1e18, proof);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_settleAndClaimWithABadSignatureSettlesAndMintsNothing() public {
        _settle(5, 1e18, 2e18);
        (Checkpoints.Checkpoint memory cp, bytes memory sig) = _newCp(9, 1.5e18, 2.5e18, BOB_PK); // not the poster
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(1.5e18, 2.5e18), 0);
        vm.prank(alice);
        vm.expectRevert(Checkpoints.BadSignature.selector);
        mining.settleAndClaim(cp, sig, 1.5e18, proof);
        assertEq(checkpoints.latestMinute(), 5);
        assertFalse(checkpoints.isSettled(9));
        assertEq(token.balanceOf(alice), 0);
        assertEq(mining.totalClaimedGross(), 0);
    }

    // ------------------------------------------------ claim-rate limit

    /// Settles M_BIG with the given entitlements and the leaves' sum as total.
    function _big(uint256 a, uint256 b) internal {
        _settle(M_BIG, a, b);
    }

    /// Alice (6,000 HLO owed) drains the bucket with one claim: 5,000 gross.
    function _drain() internal {
        _big(6000e18, 1000e18);
        _claimAs(alice, M_BIG, 6000e18, _proof(6000e18, 1000e18, 0));
    }

    function test_FreshMiningHasFullAllowance() public view {
        assertEq(mining.CLAIM_CAP(), CAP);
        assertEq(mining.CLAIM_PER_HOUR(), PER_HOUR);
        assertEq(mining.claimAvailable(), CAP);
        assertEq(mining.claimBucket(), CAP);
        assertEq(mining.bucketUpdatedAt(), block.timestamp);
    }

    function test_ClaimWithinTheBucketPaysInFullAndLowersTheAllowance() public {
        _settle(M0, 100e18, 200e18);
        _claimAs(alice, M0, 100e18, _proof(100e18, 200e18, 0));
        assertEq(token.balanceOf(alice), 90e18);
        assertEq(mining.claimAvailable(), CAP - 100e18);
        assertEq(mining.claimBucket(), CAP - 100e18);
        assertEq(mining.bucketUpdatedAt(), block.timestamp);
    }

    function test_ClaimLargerThanTheBucketIsPaidInPart() public {
        _big(6000e18, 1000e18);
        vm.expectEmit(true, true, false, true);
        emit Claimed(alice, M_BIG, CAP, 4500e18, 500e18);
        uint256 paid = _claimAs(alice, M_BIG, 6000e18, _proof(6000e18, 1000e18, 0));
        assertEq(paid, 4500e18);
        assertEq(token.balanceOf(alice), 4500e18);
        assertEq(mining.claimed(alice), CAP);
        assertEq(mining.claimAvailable(), 0);
        assertEq(mining.totalClaimedGross(), CAP);
        assertEq(mining.totalPaid(), 4500e18);
        assertEq(mining.totalRefined(), 500e18);
    }

    function test_TheRestIsClaimableAfterTheBucketRefills() public {
        _drain();
        // one hour: the refill (330) is smaller than the remainder (1,000)
        vm.warp(block.timestamp + 1 hours);
        assertEq(mining.claimAvailable(), PER_HOUR);
        vm.expectEmit(true, true, false, true);
        emit Claimed(alice, M_BIG, CAP + PER_HOUR, 297e18, 33e18);
        uint256 paid = _claimAs(alice, M_BIG, 6000e18, _proof(6000e18, 1000e18, 0));
        assertEq(paid, 297e18);
        assertEq(mining.claimed(alice), CAP + PER_HOUR);
        assertEq(mining.claimAvailable(), 0);
        // a long wait: the remainder (670) is smaller than the cap
        vm.warp(block.timestamp + 1000 days);
        vm.expectEmit(true, true, false, true);
        emit Claimed(alice, M_BIG, 6000e18, 603e18, 67e18);
        paid = _claimAs(alice, M_BIG, 6000e18, _proof(6000e18, 1000e18, 0));
        assertEq(paid, 603e18);
        assertEq(mining.claimed(alice), 6000e18);
        assertEq(mining.claimAvailable(), CAP - 670e18);
        assertEq(mining.totalClaimedGross(), 6000e18);
    }

    function test_EmptyBucketRevertsClaimLimitReached() public {
        _drain();
        bytes32[] memory p = _proof(6000e18, 1000e18, 1);
        vm.expectRevert(Mining.ClaimLimitReached.selector);
        _claimAs(bob, M_BIG, 1000e18, p);
        assertEq(mining.claimed(bob), 0);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_NothingToClaimWinsOverAnEmptyBucket() public {
        _big(6000e18, 0);
        _claimAs(alice, M_BIG, 6000e18, _proof(6000e18, 0, 0));
        assertEq(mining.claimAvailable(), 0);
        // bob owes nothing: NothingToClaim, not ClaimLimitReached
        bytes32[] memory p = _proof(6000e18, 0, 1);
        vm.expectRevert(Mining.NothingToClaim.selector);
        _claimAs(bob, M_BIG, 0, p);
    }

    function test_RefillIsLinearAndCapped() public {
        _drain();
        assertEq(mining.claimAvailable(), 0);
        vm.warp(block.timestamp + 30 minutes);
        assertEq(mining.claimAvailable(), PER_HOUR / 2);
        vm.warp(block.timestamp + 30 minutes);
        assertEq(mining.claimAvailable(), PER_HOUR);
        vm.warp(block.timestamp + 1000 days);
        assertEq(mining.claimAvailable(), CAP);
    }

    function test_ClaimForGoesThroughTheLimit() public {
        _big(1000e18, 6000e18);
        bytes32[] memory p = _proof(1000e18, 6000e18, 1);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(BOB_PK, bob, 6000e18, deadline);
        vm.expectEmit(true, true, false, true);
        emit Claimed(bob, M_BIG, CAP, 4500e18, 500e18);
        vm.prank(relayer);
        assertEq(mining.claimFor(bob, M_BIG, 6000e18, p, deadline, v, r, s), 4500e18);
        assertEq(mining.claimed(bob), CAP);
        // the bucket is empty now: the same signature, replayed, is refused by the limit
        vm.expectRevert(Mining.ClaimLimitReached.selector);
        mining.claimFor(bob, M_BIG, 6000e18, p, deadline, v, r, s);
        // after a refill the same signature claims at most the rest of what bob signed
        vm.warp(block.timestamp + 1000 days);
        deadline = block.timestamp + 1 hours;
        (v, r, s) = _sign(BOB_PK, bob, 6000e18, deadline);
        mining.claimFor(bob, M_BIG, 6000e18, p, deadline, v, r, s);
        assertEq(mining.claimed(bob), 6000e18);
        vm.expectRevert(Mining.NothingToClaim.selector);
        mining.claimFor(bob, M_BIG, 6000e18, p, deadline, v, r, s);
    }

    function test_SettleAndClaimGoesThroughTheLimit() public {
        (Checkpoints.Checkpoint memory cp, bytes memory sig) = _newCp(M_BIG, 6000e18, 1000e18, POSTER_PK);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(6000e18, 1000e18), 0);
        vm.prank(alice);
        uint256 paid = mining.settleAndClaim(cp, sig, 6000e18, proof);
        assertEq(paid, 4500e18);
        assertEq(mining.claimed(alice), CAP);
        assertEq(checkpoints.latestMinute(), M_BIG);
        // bucket empty: a second settleAndClaim on the settled checkpoint hits the limit
        vm.prank(alice);
        vm.expectRevert(Mining.ClaimLimitReached.selector);
        mining.settleAndClaim(cp, hex"", 6000e18, proof);
    }

    function test_OverEntitledAndTheBoundStillHoldWithPartialClaims() public {
        // leaves sum to 7,000 but the settled total is only 6,500
        _settleWithTotal(M_BIG, 6000e18, 1000e18, 6500e18);
        _claimAs(alice, M_BIG, 6000e18, _proof(6000e18, 1000e18, 0));
        // a partial claim adds only its gross
        assertEq(mining.totalClaimedGross(), CAP);
        assertEq(mining.maxEntitledBound(), 6500e18);
        vm.warp(block.timestamp + 1000 days);
        _claimAs(alice, M_BIG, 6000e18, _proof(6000e18, 1000e18, 0)); // the rest: 1,000
        assertEq(mining.totalClaimedGross(), 6000e18);
        // bob's 1,000 would take the claimed total to 7,000 > 6,500
        bytes32[] memory p = _proof(6000e18, 1000e18, 1);
        vm.expectRevert(Mining.OverEntitled.selector);
        _claimAs(bob, M_BIG, 1000e18, p);
        // and a failed claim does not spend the allowance
        assertEq(mining.claimAvailable(), CAP - 1000e18);
    }

    function test_ConstructorRejectsAZeroLimit() public {
        vm.expectRevert(Mining.ZeroLimit.selector);
        new Mining(address(token), address(checkpoints), 0, PER_HOUR);
        vm.expectRevert(Mining.ZeroLimit.selector);
        new Mining(address(token), address(checkpoints), CAP, 0);
    }

    /// 30 days of emission with an honest user unclaimed; a bad checkpoint hands the attacker everything.
    function test_DrainIsBoundedByTheAllowance() public {
        uint256 m = 30 * 1440;
        address attacker = address(0xBAD);
        uint256 honest = 40_000e18;
        bytes32[] memory l = new bytes32[](2);
        l[0] = MerkleHelper.leaf(alice, honest);
        l[1] = MerkleHelper.leaf(attacker, 0);
        _settleLeaves(m, l, honest);
        uint256 cap = checkpoints.emissionAllowedThrough(m + 1);
        l[0] = MerkleHelper.leaf(attacker, cap);
        l[1] = MerkleHelper.leaf(alice, 0);
        _settleLeaves(m + 1, l, cap);
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(l, 0);
        // immediately: at most CLAIM_CAP gross
        vm.prank(attacker);
        mining.claim(m + 1, cap, proof);
        assertEq(mining.claimed(attacker), CAP);
        assertEq(token.balanceOf(attacker), CAP * 9 / 10);
        vm.prank(attacker);
        vm.expectRevert(Mining.ClaimLimitReached.selector);
        mining.claim(m + 1, cap, proof);
        // then at most CLAIM_PER_HOUR per hour
        for (uint256 h = 1; h <= 3; ++h) {
            vm.warp(block.timestamp + 1 hours);
            vm.prank(attacker);
            mining.claim(m + 1, cap, proof);
            assertEq(mining.claimed(attacker), CAP + h * PER_HOUR);
        }
        assertEq(mining.totalClaimedGross(), CAP + 3 * PER_HOUR);
        // alice has claimed nothing yet; her balance now competes with the attacker for the allowance, which is why a
        // bad settled root means a permanent pause and a redeploy (a settled root cannot be revoked)
        assertEq(mining.claimed(alice), 0);
    }

    // ------------------------------------------------ recovery (Plan 7)

    function test_claimAgainstACancelledMinuteReverts() public {
        _settle(M0, 10e18, 0);
        _settle(M1, 20e18, 0); // the bad one
        vm.startPrank(guardian);
        checkpoints.pause();
        checkpoints.cancelAfter(M0);
        checkpoints.setPaused(false);
        vm.stopPrank();
        bytes32[] memory p1 = _proof(20e18, 0, 0);
        vm.expectRevert(Mining.NotSettled.selector);
        _claimAs(alice, M1, 20e18, p1);
        _claimAs(alice, M0, 10e18, _proof(10e18, 0, 0));
        assertEq(mining.claimed(alice), 10e18);
    }

    /// settleAndClaim with a cancelled checkpoint's signed file: its minute is not newer than latestMinute, and its root
    /// now reads as zero, so the call reverts StaleCheckpoint before any claim.
    function test_settleAndClaimAgainstACancelledMinuteReverts() public {
        _settle(M0, 10e18, 0);
        (Checkpoints.Checkpoint memory bad, bytes memory sig) = _newCp(M1, 20e18, 0, POSTER_PK);
        checkpoints.settle(bad, sig);
        vm.startPrank(guardian);
        checkpoints.pause();
        checkpoints.cancelAfter(M0);
        checkpoints.setPaused(false);
        vm.stopPrank();
        bytes32[] memory p1 = _proof(20e18, 0, 0);
        vm.prank(alice);
        vm.expectRevert(Mining.StaleCheckpoint.selector);
        mining.settleAndClaim(bad, sig, 20e18, p1);
        assertEq(mining.claimed(alice), 0);
    }

    function test_writeOffRaisesTheOverallBound() public {
        // A leaf above the checkpoint's total is OverEntitled; a write-off of the difference lets it through.
        _settleWithTotal(M0, 12e18, 0, 10e18);
        bytes32[] memory p = _proof(12e18, 0, 0);
        vm.expectRevert(Mining.OverEntitled.selector);
        _claimAs(alice, M0, 12e18, p);
        vm.startPrank(guardian);
        checkpoints.pause();
        checkpoints.writeOff(2e18);
        checkpoints.setPaused(false);
        vm.stopPrank();
        _claimAs(alice, M0, 12e18, p);
        assertEq(mining.claimed(alice), 12e18);
    }

    function _settleLeaves(uint256 m, bytes32[] memory l, uint256 total) internal {
        uint256 end = checkpoints.launchTime() + 60 * (m + 1);
        if (block.timestamp < end) vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
        (bytes32 root,) = MerkleHelper.rootAndProof(l, 0);
        Checkpoints.Checkpoint memory cp = Checkpoints.Checkpoint(m, block.number - 1, root, total);
        checkpoints.settle(cp, _sign(POSTER_PK, cp));
    }
}
