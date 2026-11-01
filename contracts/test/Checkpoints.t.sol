// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HloToken} from "../src/HloToken.sol";
import {Checkpoints} from "../src/Checkpoints.sol";
import {MockRefined} from "./mocks/MockRefined.sol";

contract CheckpointsTest is Test {
    HloToken token;
    Checkpoints cps;
    MockRefined refined;
    uint256 constant POSTER_PK = 0x9057E5;
    address poster = vm.addr(POSTER_PK);
    address guardian = address(0x6A);
    address pauser = address(0x9A);
    bytes32 constant ROOT = keccak256("root");

    event Settled(uint256 indexed throughMinute, uint256 refBlock, bytes32 root, uint256 totalEntitled);
    event PosterSet(address poster);
    event GuardianSet(address guardian);
    event PauserSet(address pauser);
    event PausedSet(bool paused);
    event Cancelled(uint256 fromMinute, uint256 toMinute);
    event WrittenOff(uint256 amount, uint256 total);

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        token = new HloToken();
        cps = new Checkpoints(address(token), poster, guardian, pauser, 1 hours);
        refined = new MockRefined();
        cps.setMining(address(refined));
    }

    function _cp(uint256 m, uint256 refBlock, bytes32 root, uint256 total) internal pure returns (Checkpoints.Checkpoint memory) {
        return Checkpoints.Checkpoint(m, refBlock, root, total);
    }

    function _sign(uint256 pk, Checkpoints.Checkpoint memory cp) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, cps.hashCheckpoint(cp));
        return abi.encodePacked(r, s, v);
    }

    /// Moves time so minute m is over, and one block on.
    function _after(uint256 m) internal {
        vm.warp(cps.launchTime() + 60 * (m + 1));
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _settle(uint256 m, uint256 refBlock, bytes32 root, uint256 total) internal {
        _after(m);
        Checkpoints.Checkpoint memory cp = _cp(m, refBlock, root, total);
        cps.settle(cp, _sign(POSTER_PK, cp));
    }

    function test_constructorEmitsRolesAndRecordsThePoster() public {
        vm.expectEmit(false, false, false, true);
        emit PosterSet(poster);
        vm.expectEmit(false, false, false, true);
        emit GuardianSet(guardian);
        vm.expectEmit(false, false, false, true);
        emit PauserSet(pauser);
        Checkpoints c = new Checkpoints(address(token), poster, guardian, pauser, 1 hours);
        assertEq(c.pauser(), pauser);
        assertTrue(c.wasPoster(poster));
        assertFalse(c.wasPoster(guardian));
    }

    function test_pauserOnlyPauses() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(Checkpoints.NotPauser.selector);
        cps.pause();
        vm.prank(pauser);
        cps.pause();
        assertTrue(cps.paused());
        vm.prank(pauser);
        cps.pause(); // idempotent
        vm.prank(pauser);
        vm.expectRevert(Checkpoints.NotGuardian.selector);
        cps.setPaused(false);
        vm.prank(guardian);
        cps.pause(); // the guardian may pause too
        vm.prank(guardian);
        cps.setPaused(false);
        assertFalse(cps.paused());
    }

    function test_guardianSetsThePauserAndZeroRemovesIt() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(Checkpoints.NotGuardian.selector);
        cps.setPauser(address(0x1));
        vm.prank(guardian);
        vm.expectEmit(false, false, false, true);
        emit PauserSet(address(0));
        cps.setPauser(address(0));
        assertEq(cps.pauser(), address(0));
        vm.prank(pauser);
        vm.expectRevert(Checkpoints.NotPauser.selector);
        cps.pause();
    }

    function test_setPosterRecordsHistory() public {
        address p2 = address(0x2222);
        vm.prank(guardian);
        cps.setPoster(p2);
        assertTrue(cps.wasPoster(poster));
        assertTrue(cps.wasPoster(p2));
    }

    function test_cancelAfterOnlyGuardianWhilePaused() public {
        _settle(1, 900, ROOT, 1e18);
        _settle(2, 901, keccak256("bad"), 2e18);
        vm.prank(guardian);
        vm.expectRevert(Checkpoints.NotPaused.selector);
        cps.cancelAfter(1);
        vm.prank(pauser);
        cps.pause();
        vm.prank(pauser);
        vm.expectRevert(Checkpoints.NotGuardian.selector);
        cps.cancelAfter(1);
        vm.prank(guardian);
        vm.expectEmit(false, false, false, true);
        emit Cancelled(2, 2);
        cps.cancelAfter(1);
        assertEq(cps.latestMinute(), 2);
        assertEq(cps.latestValidMinute(), 1);
        assertTrue(cps.anyValid());
        assertTrue(cps.isCancelled(2));
        assertFalse(cps.isCancelled(1));
        assertEq(cps.rootOf(2), bytes32(0));
        assertEq(cps.totalEntitledOf(2), 0);
        assertFalse(cps.isSettled(2));
        assertEq(cps.getCheckpoint(2).root, bytes32(0));
        assertEq(cps.rootOf(1), ROOT);
        assertEq(cps.cancelledCount(), 1);
        (uint256 f, uint256 t) = cps.cancelledAt(0);
        assertEq(f, 2);
        assertEq(t, 2);
    }

    function test_cancelAfterKeepRules() public {
        _settle(1, 900, ROOT, 1e18);
        _settle(3, 901, keccak256("bad"), 2e18);
        vm.prank(guardian);
        cps.pause();
        vm.startPrank(guardian);
        vm.expectRevert(Checkpoints.BadKeep.selector);
        cps.cancelAfter(2); // never settled
        vm.expectRevert(Checkpoints.BadKeep.selector);
        cps.cancelAfter(3); // nothing after it
        vm.expectRevert(Checkpoints.BadKeep.selector);
        cps.cancelAfter(4); // above latestValidMinute
        cps.cancelAfter(1);
        vm.expectRevert(Checkpoints.BadKeep.selector);
        cps.cancelAfter(1); // nothing live after it any more: 3 is already cancelled
        vm.stopPrank();
    }

    function test_settleAfterCancelChecksAgainstTheLastValid() public {
        _settle(1, 900, ROOT, 1e18);
        _settle(2, 950, keccak256("bad"), 3e18); // a higher total and a late refBlock (still within the schedule: minute 2 allows 3.3e18)
        vm.prank(guardian);
        cps.pause();
        vm.startPrank(guardian);
        cps.cancelAfter(1);
        cps.setPaused(false);
        vm.stopPrank();
        // A cancelled minute can never be settled again.
        _after(2);
        Checkpoints.Checkpoint memory again = _cp(2, 960, ROOT, 2e18);
        bytes memory sigAgain = _sign(POSTER_PK, again);
        vm.expectRevert(Checkpoints.NotNewer.selector);
        cps.settle(again, sigAgain);
        // The next minute compares with minute 1 (total 1e18, refBlock 900), not with the cancelled minute 2 (3e18, 950).
        _settle(3, 920, keccak256("good"), 2e18);
        assertEq(cps.latestMinute(), 3);
        assertEq(cps.latestValidMinute(), 3);
        assertEq(cps.rootOf(3), keccak256("good"));
    }

    function test_cancelAllThenSettleFresh() public {
        _settle(0, 900, keccak256("bad"), 1e18);
        vm.prank(guardian);
        vm.expectRevert(Checkpoints.NotPaused.selector);
        cps.cancelAll();
        vm.prank(guardian);
        cps.pause();
        vm.prank(guardian);
        vm.expectEmit(false, false, false, true);
        emit Cancelled(0, 0);
        cps.cancelAll();
        assertFalse(cps.anyValid());
        assertTrue(cps.anySettled());
        assertEq(cps.rootOf(0), bytes32(0));
        vm.prank(guardian);
        vm.expectRevert(Checkpoints.BadKeep.selector);
        cps.cancelAfter(0);
        vm.prank(guardian);
        cps.setPaused(false);
        _settle(1, 800, ROOT, 0); // no refBlock or total floor while nothing is valid
        assertTrue(cps.anyValid());
        assertEq(cps.latestValidMinute(), 1);
    }

    function test_cancelAllNeedsSomethingSettled() public {
        vm.prank(guardian);
        cps.pause();
        vm.prank(guardian);
        vm.expectRevert(Checkpoints.NothingSettled.selector);
        cps.cancelAll();
    }

    /// Each cancelled range needs a newly settled minute: a repeat cancelAll would push duplicate ranges forever, and
    /// every isCancelled (2-3 per claim) loops over them.
    function test_cancelAllCannotRepeatWhileNothingIsValid() public {
        _settle(0, 900, keccak256("bad"), 1e18);
        vm.startPrank(guardian);
        cps.pause();
        cps.cancelAll();
        vm.expectRevert(Checkpoints.NothingSettled.selector);
        cps.cancelAll();
        vm.stopPrank();
        assertEq(cps.cancelledCount(), 1);
    }

    function test_cancelAllAgainAfterANewSettle() public {
        _settle(0, 900, keccak256("bad"), 1e18);
        vm.startPrank(guardian);
        cps.pause();
        cps.cancelAll();
        cps.setPaused(false);
        vm.stopPrank();
        _settle(1, 900, keccak256("bad too"), 1e18);
        vm.startPrank(guardian);
        cps.pause();
        vm.expectEmit(false, false, false, true);
        emit Cancelled(0, 1);
        cps.cancelAll();
        vm.expectRevert(Checkpoints.NothingSettled.selector);
        cps.cancelAll();
        vm.stopPrank();
        assertEq(cps.cancelledCount(), 2);
        assertFalse(cps.anyValid());
        assertEq(cps.rootOf(1), bytes32(0));
    }

    function test_writeOffOnlyGuardianWhilePausedAndAdds() public {
        vm.prank(guardian);
        vm.expectRevert(Checkpoints.NotPaused.selector);
        cps.writeOff(1);
        vm.prank(guardian);
        cps.pause();
        vm.prank(pauser);
        vm.expectRevert(Checkpoints.NotGuardian.selector);
        cps.writeOff(1);
        vm.startPrank(guardian);
        vm.expectRevert(Checkpoints.ZeroAmount.selector);
        cps.writeOff(0);
        vm.expectEmit(false, false, false, true);
        emit WrittenOff(5e18, 5e18);
        cps.writeOff(5e18);
        cps.writeOff(2e18);
        vm.stopPrank();
        assertEq(cps.writtenOff(), 7e18);
    }

    function testFuzz_cancelledMinutesReadAsUnsettled(uint8 keepRaw, uint8 nRaw) public {
        uint256 n = bound(nRaw, 2, 20);
        uint256 keep = bound(keepRaw, 0, n - 2);
        for (uint256 m = 0; m < n; m++) _settle(m, 900 + m, keccak256(abi.encode(m)), m * 1e18);
        vm.prank(guardian);
        cps.pause();
        vm.prank(guardian);
        cps.cancelAfter(keep);
        for (uint256 m = 0; m < n; m++) {
            assertEq(cps.isSettled(m), m <= keep);
            assertEq(cps.isCancelled(m), m > keep);
        }
    }

    function test_constructorChecks() public {
        vm.expectRevert(Checkpoints.ZeroAddress.selector);
        new Checkpoints(address(0), poster, guardian, pauser, 1 hours);
        vm.expectRevert(Checkpoints.BadPeriod.selector);
        new Checkpoints(address(token), poster, guardian, pauser, 0);
        vm.expectRevert(Checkpoints.BadPeriod.selector);
        new Checkpoints(address(token), poster, guardian, pauser, 61);
        assertEq(cps.launchTime(), 1_800_000_000);
        assertEq(cps.VAULT_PERIOD(), 1 hours);
    }

    function test_setMiningOnceByDeployer() public {
        Checkpoints c = new Checkpoints(address(token), poster, guardian, pauser, 1 hours);
        vm.prank(address(0xBAD));
        vm.expectRevert(Checkpoints.NotDeployer.selector);
        c.setMining(address(refined));
        c.setMining(address(refined));
        vm.expectRevert(Checkpoints.AlreadySet.selector);
        c.setMining(address(refined));
    }

    function test_anyoneSettlesASignedCheckpoint() public {
        _after(4);
        Checkpoints.Checkpoint memory cp = _cp(4, 999, ROOT, 5e18);
        bytes memory sig = _sign(POSTER_PK, cp);
        vm.expectEmit(true, false, false, true);
        emit Settled(4, 999, ROOT, 5e18);
        vm.prank(address(0xA11CE));
        cps.settle(cp, sig);
        assertTrue(cps.anySettled());
        assertEq(cps.latestMinute(), 4);
        assertEq(cps.rootOf(4), ROOT);
        assertEq(cps.totalEntitledOf(4), 5e18);
        assertTrue(cps.isSettled(4));
        Checkpoints.Stored memory s = cps.getCheckpoint(4);
        assertEq(s.refBlock, 999);
        assertEq(s.settledAt, block.timestamp);
    }

    function test_rejectsAnotherSigner() public {
        _after(0);
        Checkpoints.Checkpoint memory cp = _cp(0, 999, ROOT, 1e18);
        bytes memory sig = _sign(0xBAD, cp);
        vm.expectRevert(Checkpoints.BadSignature.selector);
        cps.settle(cp, sig);
    }

    function test_rejectsAChangedField() public {
        _after(0);
        Checkpoints.Checkpoint memory cp = _cp(0, 999, ROOT, 1e18);
        bytes memory sig = _sign(POSTER_PK, cp);
        cp.totalEntitled = 1.1e18;
        vm.expectRevert(Checkpoints.BadSignature.selector);
        cps.settle(cp, sig);
    }

    function test_rejectsBadSignatureShapes() public {
        _after(0);
        Checkpoints.Checkpoint memory cp = _cp(0, 999, ROOT, 1e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(POSTER_PK, cps.hashCheckpoint(cp));
        vm.expectRevert(Checkpoints.BadSignature.selector);
        cps.settle(cp, abi.encodePacked(r, s)); // 64 bytes
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(n - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        vm.expectRevert(Checkpoints.BadSignature.selector);
        cps.settle(cp, abi.encodePacked(r, s2, v2)); // the malleable twin
    }

    function test_signatureIsBoundToThisContract() public {
        Checkpoints other = new Checkpoints(address(token), poster, guardian, pauser, 1 hours);
        _after(0);
        Checkpoints.Checkpoint memory cp = _cp(0, 999, ROOT, 1e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(POSTER_PK, other.hashCheckpoint(cp));
        vm.expectRevert(Checkpoints.BadSignature.selector);
        cps.settle(cp, abi.encodePacked(r, s, v));
    }

    function test_digestFollowsEip712() public view {
        Checkpoints.Checkpoint memory cp = _cp(7, 123, ROOT, 9);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("HLO Checkpoints"),
                keccak256("1"),
                block.chainid,
                address(cps)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Checkpoint(uint256 throughMinute,uint256 refBlock,bytes32 root,uint256 totalEntitled)"),
                uint256(7), uint256(123), ROOT, uint256(9)
            )
        );
        assertEq(cps.DOMAIN_SEPARATOR(), domain);
        assertEq(cps.hashCheckpoint(cp), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_onlyForward() public {
        _after(5);
        Checkpoints.Checkpoint memory a = _cp(5, 999, ROOT, 1e18);
        cps.settle(a, _sign(POSTER_PK, a));
        Checkpoints.Checkpoint memory same = _cp(5, 999, ROOT, 1e18);
        bytes memory sigSame = _sign(POSTER_PK, same);
        vm.expectRevert(Checkpoints.NotNewer.selector);
        cps.settle(same, sigSame);
        Checkpoints.Checkpoint memory older = _cp(4, 999, ROOT, 1e18);
        bytes memory sigOlder = _sign(POSTER_PK, older);
        vm.expectRevert(Checkpoints.NotNewer.selector);
        cps.settle(older, sigOlder);
    }

    function test_firstCheckpointMayBeMinuteZero() public {
        _after(0);
        Checkpoints.Checkpoint memory cp = _cp(0, 999, ROOT, 0);
        cps.settle(cp, _sign(POSTER_PK, cp));
        assertEq(cps.latestMinute(), 0);
        assertTrue(cps.anySettled());
    }

    function test_minuteMustBeOver() public {
        vm.warp(cps.launchTime() + 60 * 3 - 1); // minute 2 ends at +180
        Checkpoints.Checkpoint memory cp = _cp(2, 999, ROOT, 0);
        bytes memory sig = _sign(POSTER_PK, cp);
        vm.expectRevert(Checkpoints.MinuteNotOver.selector);
        cps.settle(cp, sig);
        vm.warp(cps.launchTime() + 60 * 3);
        cps.settle(cp, sig);
    }

    function test_refBlockRules() public {
        _after(1);
        Checkpoints.Checkpoint memory future = _cp(1, block.number, ROOT, 0);
        bytes memory sigF = _sign(POSTER_PK, future);
        vm.expectRevert(Checkpoints.BadRefBlock.selector);
        cps.settle(future, sigF);
        Checkpoints.Checkpoint memory a = _cp(1, 900, ROOT, 0);
        cps.settle(a, _sign(POSTER_PK, a));
        _after(2);
        Checkpoints.Checkpoint memory back = _cp(2, 899, ROOT, 0);
        bytes memory sigB = _sign(POSTER_PK, back);
        vm.expectRevert(Checkpoints.BadRefBlock.selector);
        cps.settle(back, sigB);
        Checkpoints.Checkpoint memory same = _cp(2, 900, ROOT, 0);
        cps.settle(same, _sign(POSTER_PK, same));
    }

    function test_zeroRootAndDecrease() public {
        _after(1);
        Checkpoints.Checkpoint memory z = _cp(1, 999, bytes32(0), 0);
        bytes memory sigZ = _sign(POSTER_PK, z);
        vm.expectRevert(Checkpoints.ZeroRoot.selector);
        cps.settle(z, sigZ);
        Checkpoints.Checkpoint memory a = _cp(1, 999, ROOT, 2e18);
        cps.settle(a, _sign(POSTER_PK, a));
        _after(2);
        Checkpoints.Checkpoint memory down = _cp(2, 999, ROOT, 2e18 - 1);
        bytes memory sigD = _sign(POSTER_PK, down);
        vm.expectRevert(Checkpoints.EntitlementDecreased.selector);
        cps.settle(down, sigD);
    }

    function test_capIsScheduleThroughTheMinutePlusRefining() public {
        _after(9); // minutes 0..9: 10 minutes → 11 HLO
        refined.set(3e17);
        Checkpoints.Checkpoint memory over = _cp(9, 999, ROOT, 11e18 + 3e17 + 1);
        bytes memory sigO = _sign(POSTER_PK, over);
        vm.expectRevert(Checkpoints.OverSchedule.selector);
        cps.settle(over, sigO);
        Checkpoints.Checkpoint memory exact = _cp(9, 999, ROOT, 11e18 + 3e17);
        cps.settle(exact, _sign(POSTER_PK, exact));
        assertEq(cps.emissionAllowedThrough(9), 11e18);
    }

    function test_emissionLimitedBySupplyRoom() public view {
        uint256 room = 5_000_000e18 - 10_000e18;
        uint256 m = room / 1.1e18 + 10;
        assertEq(cps.emissionAllowedThrough(m), room);
    }

    function test_pauseStopsSettling() public {
        _after(0);
        Checkpoints.Checkpoint memory cp = _cp(0, 999, ROOT, 0);
        bytes memory sig = _sign(POSTER_PK, cp);
        vm.prank(address(0xBAD));
        vm.expectRevert(Checkpoints.NotGuardian.selector);
        cps.setPaused(true);
        vm.prank(guardian);
        cps.setPaused(true);
        vm.expectRevert(Checkpoints.IsPaused.selector);
        cps.settle(cp, sig);
        vm.prank(guardian);
        cps.setPaused(false);
        cps.settle(cp, sig);
    }

    function test_guardianReplacesPosterAndItself() public {
        uint256 newPk = 0x2222;
        vm.prank(guardian);
        cps.setPoster(vm.addr(newPk));
        _after(0);
        Checkpoints.Checkpoint memory cp = _cp(0, 999, ROOT, 0);
        bytes memory oldSig = _sign(POSTER_PK, cp);
        vm.expectRevert(Checkpoints.BadSignature.selector);
        cps.settle(cp, oldSig);
        cps.settle(cp, _sign(newPk, cp));
        vm.prank(guardian);
        vm.expectRevert(Checkpoints.ZeroAddress.selector);
        cps.setPoster(address(0));
        vm.prank(guardian);
        cps.setGuardian(address(0x77));
        assertEq(cps.guardian(), address(0x77));
        vm.prank(guardian);
        vm.expectRevert(Checkpoints.NotGuardian.selector);
        cps.setPaused(true);
    }
}
