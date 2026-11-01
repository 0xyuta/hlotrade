// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {HloToken} from "../src/HloToken.sol";
import {Checkpoints} from "../src/Checkpoints.sol";
import {Mining} from "../src/Mining.sol";
import {Staking} from "../src/Staking.sol";
import {Buyback} from "../src/Buyback.sol";
import {Splitter} from "../src/Splitter.sol";
import {Profiles} from "../src/Profiles.sol";

/// Env: USDC, V2_FACTORY, SWAP_FEE_BPS, POSTER, GUARDIAN, PAUSER, ADMIN, VAULT_PERIOD (seconds; default 7 days; must be
/// 7 days on chain 999), CLAIM_CAP (default 5000 ether) and CLAIM_PER_HOUR (default 330 ether), Mining's claim-rate
/// limit (both must be exactly those defaults on chain 999).
/// PAUSER is the verifier's pause-only key address (optional off mainnet; on chain 999 it is required and must differ
/// from POSTER and GUARDIAN). GUARDIAN must be a contract (the Safe) on chain 999.
/// Before mainnet, check on chain that V2_FACTORY is a Uniswap-v2-style factory
/// (getPair/createPair, pairs with getReserves/price0CumulativeLast) and that
/// SWAP_FEE_BPS matches its pairs' fee.
contract Deploy is Script {
    /// Added to Checkpoints' launch time for Buyback (see deploy()).
    uint256 public constant LAUNCH_MARGIN = 1 hours;
    /// Mining's claim-rate limit: 5,000 HLO at once, refilled at 330 HLO per hour (5x the emission).
    uint256 public constant DEFAULT_CLAIM_CAP = 5000 ether;
    uint256 public constant DEFAULT_CLAIM_PER_HOUR = 330 ether;

    struct Roles {
        address poster;
        address guardian;
        address pauser;
        address admin;
    }

    struct Deployed {
        address token;
        address checkpoints;
        address mining;
        address staking;
        address buyback;
        address splitter;
        address profiles;
        address pair;
    }

    function run() external returns (Deployed memory d) {
        address usdc = vm.envAddress("USDC");
        address factory = vm.envAddress("V2_FACTORY");
        uint256 feeBps = vm.envUint("SWAP_FEE_BPS");
        address poster = vm.envAddress("POSTER");
        address guardian = vm.envAddress("GUARDIAN");
        address pauser = vm.envOr("PAUSER", address(0));
        address admin = vm.envAddress("ADMIN");
        uint256 vaultPeriod = vm.envOr("VAULT_PERIOD", uint256(7 days));
        vm.startBroadcast();
        uint256 claimCap = vm.envOr("CLAIM_CAP", DEFAULT_CLAIM_CAP);
        uint256 claimPerHour = vm.envOr("CLAIM_PER_HOUR", DEFAULT_CLAIM_PER_HOUR);
        d = deploy(usdc, factory, feeBps, Roles(poster, guardian, pauser, admin), vaultPeriod, claimCap, claimPerHour);
        vm.stopBroadcast();
        _write(d);
    }

    function deploy(
        address usdc,
        address factory,
        uint256 swapFeeBps,
        Roles memory roles,
        uint256 vaultPeriod,
        uint256 claimCap,
        uint256 claimPerHour
    ) public returns (Deployed memory d) {
        _checkInputs(usdc, factory);
        if (block.chainid == 999) {
            require(vaultPeriod == 7 days, "VAULT_PERIOD");
            require(claimCap == DEFAULT_CLAIM_CAP && claimPerHour == DEFAULT_CLAIM_PER_HOUR, "CLAIM_LIMIT");
            require(roles.guardian.code.length > 0, "GUARDIAN_NOT_A_SAFE");
            require(roles.pauser != address(0) && roles.pauser != roles.guardian && roles.pauser != roles.poster, "PAUSER");
        }
        // The addresses live in `d`, not in locals: with nine parameters the stack is too deep for more locals.
        d.token = address(new HloToken());
        d.checkpoints = address(new Checkpoints(d.token, roles.poster, roles.guardian, roles.pauser, vaultPeriod));
        d.mining = address(new Mining(d.token, d.checkpoints, claimCap, claimPerHour));
        Checkpoints(d.checkpoints).setMining(d.mining);
        d.staking = address(new Staking(d.token));
        // A broadcast reads checkpoints.launchTime() from forge's simulation, which can be earlier than the block Checkpoints
        // actually lands in. The margin keeps the pool opening at least 7 days after the real launch.
        d.buyback = address(
            new Buyback(
                d.token, usdc, factory, d.staking, Checkpoints(d.checkpoints).launchTime() + LAUNCH_MARGIN, swapFeeBps
            )
        );
        d.pair = address(Buyback(d.buyback).pair());
        d.splitter = address(new Splitter(usdc, d.buyback, roles.admin));
        HloToken(d.token).setMinters(d.mining, d.buyback, d.pair);
        d.profiles = address(new Profiles());
    }

    /// Both addresses must be contracts, and USDC must report 6 decimals.
    function _checkInputs(address usdc, address factory) internal view {
        require(usdc.code.length > 0 && factory.code.length > 0, "NO_CODE");
        (bool ok, bytes memory ret) = usdc.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && ret.length >= 32 && abi.decode(ret, (uint256)) == 6, "USDC_DECIMALS");
    }

    function _write(Deployed memory d) internal {
        string memory k = "d";
        vm.serializeAddress(k, "token", d.token);
        vm.serializeAddress(k, "checkpoints", d.checkpoints);
        vm.serializeAddress(k, "mining", d.mining);
        vm.serializeAddress(k, "staking", d.staking);
        vm.serializeAddress(k, "buyback", d.buyback);
        vm.serializeAddress(k, "splitter", d.splitter);
        vm.serializeAddress(k, "profiles", d.profiles);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        string memory json = vm.serializeAddress(k, "pair", d.pair);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
