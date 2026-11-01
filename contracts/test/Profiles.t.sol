// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Profiles} from "../src/Profiles.sol";

contract ProfilesTest is Test {
    Profiles p;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        p = new Profiles();
    }

    function test_SetAndChangeName() public {
        vm.prank(alice);
        p.setName("yuta");
        assertEq(p.nameOf(alice), "yuta");
        assertEq(p.ownerOfName(keccak256("yuta")), alice);
        vm.prank(alice);
        p.setName("yuta_2");
        assertEq(p.ownerOfName(keccak256("yuta")), address(0));
        assertEq(p.nameOf(alice), "yuta_2");
    }

    function test_NameTaken() public {
        vm.prank(alice);
        p.setName("yuta");
        vm.prank(bob);
        vm.expectRevert(Profiles.NameTaken.selector);
        p.setName("yuta");
    }

    function test_ClearFreesName() public {
        vm.prank(alice);
        p.setName("yuta");
        vm.prank(alice);
        p.clearName();
        assertEq(bytes(p.nameOf(alice)).length, 0);
        vm.prank(bob);
        p.setName("yuta");
        assertEq(p.ownerOfName(keccak256("yuta")), bob);
    }

    function test_BadNames() public {
        string[] memory bad = new string[](5);
        bad[0] = "ab";
        bad[1] = "seventeen_chars_x";
        bad[2] = "Yuta";
        bad[3] = "yu ta";
        bad[4] = "yu-ta";
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(Profiles.BadName.selector);
            p.setName(bad[i]);
        }
    }

    function test_Avatar() public {
        vm.prank(alice);
        p.setAvatar(31);
        assertEq(p.avatarOf(alice), 31);
        vm.prank(alice);
        vm.expectRevert(Profiles.BadAvatar.selector);
        p.setAvatar(32);
    }
}
