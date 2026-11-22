// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/RookeryCurve2.sol";
import "../src/RookeryRouter.sol";

/// the router against a real launchpad curve (RookeryCurve2) on a Robinhood Chain fork
contract RouterCurveForkTest is Test {
    RookeryCurve2 curve; RookeryRouter router; RookeryToken2 t;
    address owner = address(0xA11CE); address sink = address(0xB0B0); address user = address(0xCAFE); address alice = address(0xA1);

    function setUp() public {
        vm.createSelectFork("rh");
        (address weth, address f, address r) = (vm.envAddress("RH_WETH"), vm.envAddress("RH_FACTORY_V2"), vm.envAddress("RH_ROUTER"));
        curve = new RookeryCurve2(weth, f, r, address(0xFEE), 2.4 ether);
        vm.deal(alice, 10 ether); vm.deal(user, 10 ether);
        vm.prank(alice);
        t = RookeryToken2(curve.create{value: 0.1 ether}("Hood Penguin", "HPNG", address(0), 100, 50, 100, 0, 0));
        router = new RookeryRouter(owner, sink);
        address[] memory a = new address[](2); bytes4[] memory s = new bytes4[](2); uint8[] memory d = new uint8[](2);
        (a[0], s[0], d[0]) = (address(curve), RookeryCurve2.buy.selector, 1);
        (a[1], s[1], d[1]) = (address(curve), RookeryCurve2.sell.selector, 2);
        vm.prank(owner); router.setAllowed(a, s, d);
    }

    /// launchpads that refuse contract buyers before bonding: the router reverts cleanly, the user keeps everything
    function test_prelaunch_contract_block_is_clean() public {
        uint256 u0 = user.balance;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(RookeryRouter.CallFailed.selector, abi.encodeWithSelector(RookeryToken2.NoContractsBeforeLaunch.selector)));
        router.buy{value: 1 ether}(address(curve), abi.encodeWithSelector(RookeryCurve2.buy.selector, address(t), 0, 0), address(t), 0, user, block.timestamp + 60);
        assertEq(user.balance, u0); assertEq(sink.balance, 0); assertEq(address(router).balance, 0);
    }

    /// after bonding: buy and sell on the real Uniswap V2 pool through the official SwapRouter02
    function test_graduated_dex_route() public {
        address swap = vm.envAddress("RH_ROUTER"); address weth = vm.envAddress("RH_WETH");
        vm.deal(alice, 50 ether);
        vm.prank(alice); curve.buy{value: 12 ether}(address(t), 0, 0);
        curve.graduate(address(t));
        assertTrue(t.launched(), "launched");
        address[] memory a = new address[](2); bytes4[] memory s = new bytes4[](2); uint8[] memory d = new uint8[](2);
        (a[0], s[0], d[0]) = (swap, bytes4(0x472b43f3), 1);       // swapExactTokensForTokens(uint256,uint256,address[],address)
        (a[1], s[1], d[1]) = (swap, bytes4(0x5ae401dc), 2);       // multicall(uint256,bytes[]): swap + unwrapWETH9
        vm.prank(owner); router.setAllowed(a, s, d);

        address[] memory path = new address[](2); path[0] = weth; path[1] = address(t);
        vm.prank(user);
        uint256 out = router.buy{value: 1 ether}(swap, abi.encodeWithSelector(bytes4(0x472b43f3), 0.995 ether, 0, path, address(router)),
            address(t), 1, user, block.timestamp + 60);
        assertEq(sink.balance, 0.005 ether, "fee on DEX buy");
        assertEq(t.balanceOf(user), out); emit log_named_uint("DEX buy: tokens to user", out);

        path[0] = address(t); path[1] = weth;
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(bytes4(0x472b43f3), out, 0, path, address(2));          // ADDRESS_THIS: keep WETH in SwapRouter02
        calls[1] = abi.encodeWithSelector(bytes4(0x49404b7c), 0, address(router));                // unwrapWETH9(min, our router)
        uint256 u0 = user.balance; uint256 s0 = sink.balance;
        vm.startPrank(user); t.approve(address(router), out);
        uint256 net = router.sell(swap, abi.encodeWithSelector(bytes4(0x5ae401dc), block.timestamp + 60, calls), address(t), out, 0.5 ether, payable(user), block.timestamp + 60);
        vm.stopPrank();
        emit log_named_uint("DEX sell: native to user", net);
        assertEq(user.balance - u0, net); uint256 fee = sink.balance - s0; assertEq(fee, ((net + fee) * 50) / 10000, "fee 0.5% of proceeds");
        assertEq(address(router).balance, 0); assertEq(t.balanceOf(address(router)), 0); assertEq(t.allowance(address(router), swap), 0);
    }
}
