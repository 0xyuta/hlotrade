// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deploy} from "./Deploy.s.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockV2Factory} from "../test/mocks/MockV2.sol";

/// @notice Anvil only: the real deploy with a mock 6-decimal USDC and a mock V2 factory.
///         forge script script/DevDeploy.s.sol --sig "runDev()" --rpc-url http://127.0.0.1:8546 --broadcast --private-key <anvil #0>
contract DevDeploy is Deploy {
    function runDev() external returns (Deployed memory d) {
        require(block.chainid == 31337, "ANVIL_ONLY");
        address poster = vm.envAddress("POSTER");
        address guardian = vm.envAddress("GUARDIAN");
        address pauser = vm.envOr("PAUSER", address(0));
        address admin = vm.envAddress("ADMIN");
        vm.startBroadcast();
        MockERC20 usdc = new MockERC20("USDC", 6);
        MockV2Factory factory = new MockV2Factory();
        d = deploy(
            address(usdc),
            address(factory),
            30,
            Roles(poster, guardian, pauser, admin),
            vm.envOr("VAULT_PERIOD", uint256(1 hours)),
            vm.envOr("CLAIM_CAP", DEFAULT_CLAIM_CAP),
            vm.envOr("CLAIM_PER_HOUR", DEFAULT_CLAIM_PER_HOUR)
        );
        vm.stopBroadcast();
        _write(d);
    }
}
