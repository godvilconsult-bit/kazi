// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KaziBase} from "./Base.t.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {ProviderKind, ProviderStatus} from "../src/interfaces/IKazi.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract AgentRegistryTest is KaziBase {
    function _register() internal returns (uint256 id) {
        vm.prank(dev);
        id = registry.register(ProviderKind.HUMAN, payout, "ipfs://a", keccak256("a"));
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        new AgentRegistry(address(0), 1, 1);
    }

    function test_register_startsPending() public {
        vm.expectEmit(address(registry));
        emit AgentRegistry.ProviderRegistered(
            1, dev, ProviderKind.HUMAN, payout, "ipfs://a", keccak256("a")
        );
        uint256 id = _register();
        AgentRegistry.Provider memory p = registry.getProvider(id);
        assertEq(p.owner, dev);
        assertEq(uint8(p.status), uint8(ProviderStatus.PENDING));
        assertEq(registry.ownerOf(id), dev);
        assertEq(uint8(registry.kindOf(id)), uint8(ProviderKind.HUMAN));
        assertEq(registry.payoutOf(id), payout);
        assertEq(registry.nextProviderId(), 2);

        vm.prank(dev);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.register(ProviderKind.AGENT, address(0), "", bytes32(0));
    }

    function test_unknownProvider_reverts_butStatusIsNone() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.UnknownProvider.selector, 42));
        registry.ownerOf(42);
        assertEq(uint8(registry.statusOf(42)), uint8(ProviderStatus.NONE));
    }

    function test_activate_requiresBondAndRole() public {
        uint256 id = _register();
        vm.prank(registrar);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InsufficientStake.selector, id, 0, MIN_HUMAN)
        );
        registry.activate(id);

        _giveKazi(dev, MIN_HUMAN);
        vm.startPrank(dev);
        kazi.approve(address(vault), MIN_HUMAN);
        vault.bond(id, MIN_HUMAN);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                dev,
                registry.REGISTRAR_ROLE()
            )
        );
        vm.prank(dev);
        registry.activate(id);

        vm.startPrank(registrar);
        registry.activate(id);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidStatus.selector, id, ProviderStatus.ACTIVE)
        );
        registry.activate(id);
        registry.suspend(id);
        registry.activate(id); // re-activate from SUSPENDED
        vm.stopPrank();
        assertEq(uint8(registry.statusOf(id)), uint8(ProviderStatus.ACTIVE));
    }

    function test_activate_revertsWithoutVault() public {
        AgentRegistry fresh = new AgentRegistry(admin, 0, 0);
        vm.prank(dev);
        uint256 id = fresh.register(ProviderKind.AGENT, payout, "", bytes32(0));
        bytes32 registrarRole = fresh.REGISTRAR_ROLE();
        vm.prank(admin);
        fresh.grantRole(registrarRole, registrar);
        vm.prank(registrar);
        vm.expectRevert(AgentRegistry.StakingVaultNotSet.selector);
        fresh.activate(id);
    }

    function test_suspend_onlyFromActiveOrPending() public {
        uint256 id = _register();
        vm.startPrank(registrar);
        registry.suspend(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.InvalidStatus.selector, id, ProviderStatus.SUSPENDED
            )
        );
        registry.suspend(id);
        vm.stopPrank();
    }

    function test_updateMetadata() public {
        uint256 id = _register();
        vm.prank(dev);
        registry.updateMetadata(id, "ipfs://b", keccak256("b"));
        assertEq(registry.getProvider(id).metadataURI, "ipfs://b");

        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotProviderOwner.selector, id));
        registry.updateMetadata(id, "x", bytes32(0));

        vm.prank(dev);
        registry.delist(id);
        vm.prank(dev);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.InvalidStatus.selector, id, ProviderStatus.DELISTED
            )
        );
        registry.updateMetadata(id, "x", bytes32(0));
    }

    function test_payoutChange_isDelayed() public {
        uint256 id = _register();
        address newPayout = makeAddr("newPayout");
        vm.startPrank(dev);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NoPendingPayout.selector, id));
        registry.confirmPayoutChange(id);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.requestPayoutChange(id, address(0));

        registry.requestPayoutChange(id, newPayout);
        (, uint64 effectiveAt) = registry.pendingPayouts(id);
        assertEq(effectiveAt, block.timestamp + 2 days);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.PayoutChangeNotReady.selector, id, effectiveAt)
        );
        registry.confirmPayoutChange(id);
        assertEq(registry.payoutOf(id), payout); // not effective yet

        vm.warp(effectiveAt);
        registry.confirmPayoutChange(id);
        vm.stopPrank();
        assertEq(registry.payoutOf(id), newPayout);
    }

    function test_payoutChange_cancelByOwnerOrRegistrar() public {
        uint256 id = _register();
        vm.prank(dev);
        registry.requestPayoutChange(id, makeAddr("thief"));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotProviderOwner.selector, id));
        registry.cancelPayoutChange(id);

        vm.prank(registrar);
        registry.cancelPayoutChange(id);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NoPendingPayout.selector, id));
        registry.cancelPayoutChange(id);

        vm.startPrank(dev);
        registry.delist(id);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.InvalidStatus.selector, id, ProviderStatus.DELISTED
            )
        );
        registry.requestPayoutChange(id, makeAddr("x"));
        vm.stopPrank();
    }

    function test_delist_ownerOrRegistrarOnly() public {
        uint256 id = _register();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.NotProviderOwner.selector, id));
        registry.delist(id);

        vm.expectEmit(address(registry));
        emit AgentRegistry.ProviderDelisted(id, registrar);
        vm.prank(registrar);
        registry.delist(id);

        vm.prank(dev);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentRegistry.InvalidStatus.selector, id, ProviderStatus.DELISTED
            )
        );
        registry.delist(id);
    }

    function test_admin_setters() public {
        vm.startPrank(admin);
        registry.setMinStake(ProviderKind.AGENT, 1);
        assertEq(registry.minStake(ProviderKind.AGENT), 1);
        registry.setPayoutDelay(1 days);
        assertEq(registry.payoutDelay(), 1 days);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidPayoutDelay.selector, uint64(1 hours))
        );
        registry.setPayoutDelay(1 hours);
        vm.expectRevert(
            abi.encodeWithSelector(AgentRegistry.InvalidPayoutDelay.selector, uint64(31 days))
        );
        registry.setPayoutDelay(31 days);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.setStakingVault(address(0));
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, dev, bytes32(0)
            )
        );
        vm.prank(dev);
        registry.setMinStake(ProviderKind.HUMAN, 0);
    }
}
