// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ZroAutoBridge.sol";

/// The bridge against LayerZero's real ZRO contract on an Ethereum fork. ZRO is the token AND the OFT. The route is
/// closed today: the closed case runs for real; for the open case quoteSend/send are answered at the OFT boundary and
/// the test checks the exact send() call the real contract receives (destination, amount, EID) plus every real ERC-20
/// movement. With the real OFT, send() pulls `bridged` from the bridge using the approval checked here.
contract ZroAutoBridgeForkTest is Test {
    address constant ZRO = 0x6985884C4392D348587B19cb9eAAf157F13271cd;
    ZroAutoBridge br; uint256 brNative0;
    address owner = address(0xA11CE); address sink = address(0xB0B0); address user = address(0xCAFE);
    uint32 constant ZERO_EID = 33002;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC", string("https://ethereum-rpc.publicnode.com")));
        br = new ZroAutoBridge(owner, sink, ZRO, ZRO, ZERO_EID);
        brNative0 = address(br).balance;                                 // a fork address may already hold dust
        deal(ZRO, user, 100 ether);
        vm.deal(user, 1 ether);
        vm.prank(user); IERC20Bridge(ZRO).approve(address(br), type(uint256).max);
    }

    function _expectSend(uint256 bridged, uint256 nativeFee) internal {
        SendParam memory p = SendParam({ dstEid: ZERO_EID, to: bytes32(uint256(uint160(user))), amountLD: bridged, minAmountLD: bridged,
            extraOptions: "", composeMsg: "", oftCmd: "" });
        MessagingFee memory f = MessagingFee({ nativeFee: nativeFee, lzTokenFee: 0 });
        vm.mockCall(ZRO, abi.encodeWithSelector(IOFTBridge.quoteSend.selector), abi.encode(f));
        vm.mockCall(ZRO, abi.encodeWithSelector(IOFTBridge.send.selector), abi.encode(bytes32(uint256(7)), uint64(1), f));
        vm.expectCall(ZRO, nativeFee, abi.encodeWithSelector(IOFTBridge.send.selector, p, f, user));   // exact call to the real OFT
    }

    function test_route_is_closed_today_and_nothing_moves() public {
        vm.prank(user); br.signUp{ value: 0.01 ether }(10 ether, 0);
        vm.expectRevert(ZroAutoBridge.RouteClosed.selector);
        br.fire(user);                                                   // real LayerZero answer: closed
        vm.prank(user); vm.expectRevert(ZroAutoBridge.RouteClosed.selector);
        br.bridgeNow{ value: 0.01 ether }(10 ether);
        assertEq(IERC20Bridge(ZRO).balanceOf(user), 100 ether);
        assertEq(br.orderOf(user).deposit, 0.01 ether);
    }

    function test_open_route_auto_bridge_real_zro() public {
        vm.prank(user); br.signUp{ value: 0.01 ether }(10 ether, 0);
        _expectSend(9.95 ether, 0.0008 ether);
        uint256 u0 = user.balance;
        br.fire(user);
        assertEq(IERC20Bridge(ZRO).balanceOf(user), 90 ether, "exactly the signed 10 ZRO left the wallet");
        assertEq(IERC20Bridge(ZRO).balanceOf(sink), 0.05 ether, "0.5% fee in ZRO");
        assertEq(IERC20Bridge(ZRO).balanceOf(address(br)), 9.95 ether, "the bridged part is what the OFT pulls");
        assertEq(IERC20Bridge(ZRO).allowance(address(br), ZRO), 0, "approval to the OFT reset after send");
        assertEq(user.balance, u0 + 0.0092 ether, "deposit minus LayerZero's 0.0008 came back");
        assertEq(address(br).balance, brNative0, "bridge keeps no native");
        assertEq(br.pending().length, 0);
    }

    function test_open_route_bridgeNow_real_zro_one_tx() public {
        _expectSend(19.94 ether, 0.0008 ether);
        uint256 u0 = user.balance;
        vm.prank(user); br.bridgeNow{ value: 0.002 ether }(20 ether);
        assertEq(IERC20Bridge(ZRO).balanceOf(user), 80 ether, "20 ZRO left the wallet (19.94 bridged + 0.06 fee)");
        assertEq(IERC20Bridge(ZRO).balanceOf(sink), 0.06 ether, "0.3% manual fee");
        assertEq(IERC20Bridge(ZRO).allowance(address(br), ZRO), 0);
        assertEq(user.balance, u0 - 0.0008 ether, "one transaction, unused native refunded");
        assertEq(address(br).balance, brNative0, "bridge keeps no native");
    }
}
