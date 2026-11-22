// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/RookeryRouter.sol";
import "./mocks/MockPads.sol";

contract RookeryRouterTest is Test {
    RookeryRouter router; MockToken tok; MockToken taxTok; MockPad pad; MockPad taxPad; MockV2Router dex;
    address owner = address(0xA11CE); address sink = address(0xB0B0); address user = address(0xCAFE); address other = address(0xD00D);
    uint256 constant DL = type(uint256).max;

    function setUp() public {
        router = new RookeryRouter(owner, sink);
        tok = new MockToken(0); taxTok = new MockToken(300);
        pad = new MockPad(tok); taxPad = new MockPad(taxTok); dex = new MockV2Router(tok);
        vm.deal(address(pad), 100 ether); vm.deal(address(taxPad), 100 ether); vm.deal(address(dex), 100 ether); vm.deal(user, 100 ether);
        address[] memory t = new address[](7); bytes4[] memory s = new bytes4[](7); uint8[] memory d = new uint8[](7);
        (t[0], s[0], d[0]) = (address(pad), MockPad.buy.selector, 1);
        (t[1], s[1], d[1]) = (address(pad), MockPad.sell.selector, 2);
        (t[2], s[2], d[2]) = (address(pad), MockPad.buyFor.selector, 1);
        (t[3], s[3], d[3]) = (address(taxPad), MockPad.buy.selector, 1);
        (t[4], s[4], d[4]) = (address(dex), MockV2Router.swapExactETHForTokensSupportingFeeOnTransferTokens.selector, 1);
        (t[5], s[5], d[5]) = (address(dex), MockV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens.selector, 2);
        (t[6], s[6], d[6]) = (address(pad), MockPad.sellHalf.selector, 2);
        vm.prank(owner); router.setAllowed(t, s, d);
    }

    function _buy(uint256 v, uint256 minOut) internal returns (uint256) {
        vm.prank(user);
        return router.buy{value: v}(address(pad), abi.encodeWithSelector(MockPad.buy.selector, address(tok), 0), address(tok), minOut, user, DL);
    }

    function test_buy_takes_half_percent_and_delivers() public {
        uint256 out = _buy(1 ether, 0);
        assertEq(sink.balance, 0.005 ether, "fee 0.5%");
        assertEq(out, 0.995 ether * 1000, "tokens for 99.5%");
        assertEq(tok.balanceOf(user), out);
        assertEq(tok.balanceOf(address(router)), 0); assertEq(address(router).balance, 0);
    }

    function test_buy_slippage_after_fee() public {
        vm.expectRevert(RookeryRouter.Slippage.selector); _buy(1 ether, 1 ether * 1000);   // 100% of value cannot arrive
    }

    function test_buy_refund_goes_back_to_user() public {
        pad.setRefund(4000);                                       // curve fills up: 40% of what it got comes back
        uint256 b0 = user.balance;
        _buy(1 ether, 0);
        uint256 refund = (0.995 ether * 4000) / 10000;
        assertEq(user.balance, b0 - 1 ether + refund, "refund forwarded");
        assertEq(sink.balance, 0.005 ether); assertEq(address(router).balance, 0);
    }

    function test_buy_explicit_recipient_pad() public {
        vm.prank(user);
        uint256 out = router.buy{value: 1 ether}(address(pad), abi.encodeWithSelector(MockPad.buyFor.selector, address(tok), address(router)), address(tok), 0, other, DL);
        assertEq(tok.balanceOf(other), out); assertEq(out, 0.995 ether * 1000);
    }

    function test_buy_tokens_sent_elsewhere_reverts() public {
        vm.prank(user); vm.expectRevert(RookeryRouter.Slippage.selector);
        router.buy{value: 1 ether}(address(pad), abi.encodeWithSelector(MockPad.buyFor.selector, address(tok), user), address(tok), 0, user, DL);
    }

    function test_buy_transfer_tax_min_out_is_what_user_gets() public {
        vm.prank(user);
        uint256 out = router.buy{value: 1 ether}(address(taxPad), abi.encodeWithSelector(MockPad.buy.selector, address(taxTok), 0), address(taxTok), 0, user, DL);
        assertEq(out, (0.995 ether * 1000 * 9700) / 10000, "3% transfer tax counted");
        assertEq(taxTok.balanceOf(user), out);
        vm.prank(user); vm.expectRevert(RookeryRouter.Slippage.selector);
        router.buy{value: 1 ether}(address(taxPad), abi.encodeWithSelector(MockPad.buy.selector, address(taxTok), 0), address(taxTok), 0.995 ether * 1000, user, DL);
    }

    function test_sell_takes_half_percent() public {
        uint256 got = _buy(1 ether, 0);
        uint256 s0 = sink.balance; uint256 u0 = user.balance;
        vm.startPrank(user);
        tok.approve(address(router), got);
        uint256 net = router.sell(address(pad), abi.encodeWithSelector(MockPad.sell.selector, address(tok), got, 0), address(tok), got, 0, payable(user), DL);
        vm.stopPrank();
        uint256 gross = got / 1000;
        assertEq(sink.balance - s0, (gross * 50) / 10000, "fee 0.5% of proceeds");
        assertEq(net, gross - (gross * 50) / 10000); assertEq(user.balance - u0, net);
        assertEq(tok.allowance(address(router), address(pad)), 0, "approval reset");
        assertEq(tok.balanceOf(address(router)), 0); assertEq(address(router).balance, 0);
    }

    function test_sell_unsold_tokens_refunded() public {
        uint256 got = _buy(1 ether, 0);
        vm.startPrank(user);
        tok.approve(address(router), got);
        router.sell(address(pad), abi.encodeWithSelector(MockPad.sellHalf.selector, address(tok), got), address(tok), got, 0, payable(user), DL);
        vm.stopPrank();
        assertEq(tok.balanceOf(user), got - got / 2, "half came back");
        assertEq(tok.balanceOf(address(router)), 0);
    }

    function test_sell_min_out_after_fee() public {
        uint256 got = _buy(1 ether, 0);
        vm.startPrank(user); tok.approve(address(router), got);
        vm.expectRevert(RookeryRouter.Slippage.selector);
        router.sell(address(pad), abi.encodeWithSelector(MockPad.sell.selector, address(tok), got, 0), address(tok), got, got / 1000, payable(user), DL);
        vm.stopPrank();
    }

    function test_dex_v2_buy_and_sell() public {
        address[] memory path = new address[](2); path[0] = address(0xEEEE); path[1] = address(tok);
        vm.prank(user);
        uint256 out = router.buy{value: 2 ether}(address(dex),
            abi.encodeWithSelector(MockV2Router.swapExactETHForTokensSupportingFeeOnTransferTokens.selector, 0, path, address(router), DL), address(tok), 0, user, DL);
        assertEq(out, 1.99 ether * 500); assertEq(sink.balance, 0.01 ether);
        vm.startPrank(user); tok.approve(address(router), out);
        uint256 net = router.sell(address(dex),
            abi.encodeWithSelector(MockV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens.selector, out, 0, path, address(router), DL), address(tok), out, 0, payable(user), DL);
        vm.stopPrank();
        assertEq(net, 1.99 ether - (1.99 ether * 50) / 10000);
    }

    // ---------------------------------------------------------------- abuse
    function test_unlisted_target_or_selector_rejected() public {
        vm.prank(user); vm.expectRevert(RookeryRouter.NotAllowed.selector);
        router.buy{value: 1 ether}(address(pad), abi.encodeWithSelector(MockPad.setRefund.selector, 0), address(tok), 0, user, DL);
        vm.prank(user); vm.expectRevert(RookeryRouter.NotAllowed.selector);
        router.buy{value: 1 ether}(address(dex), abi.encodeWithSelector(MockV2Router.swapExactTokensForETHSupportingFeeOnTransferTokens.selector, 0, 0, new address[](0), user, DL), address(tok), 0, user, DL);
        vm.prank(user); vm.expectRevert(RookeryRouter.NotAllowed.selector);
        router.sell(address(pad), abi.encodeWithSelector(MockPad.buy.selector, address(tok), 0), address(tok), 1, 0, payable(user), DL);
    }

    function test_token_as_target_rejected() public {
        vm.prank(user); vm.expectRevert(RookeryRouter.BadTarget.selector);
        router.buy{value: 1 ether}(address(tok), abi.encodeWithSelector(MockToken.transfer.selector, user, 1), address(tok), 0, user, DL);
    }

    function test_reentrancy_blocked() public {
        pad.setEvil(true, address(router));
        vm.prank(user); vm.expectRevert();
        router.buy{value: 1 ether}(address(pad), abi.encodeWithSelector(MockPad.buy.selector, address(tok), 0), address(tok), 0, user, DL);
    }

    function test_no_native_accepted_outside_trades() public {
        vm.prank(user); (bool ok,) = address(router).call{value: 1 ether}(""); assertFalse(ok);
    }

    function test_pause_deadline_fee_cap_and_owner() public {
        vm.prank(owner); router.setPaused(true);
        vm.expectRevert(RookeryRouter.IsPaused.selector); _buy(1 ether, 0);
        vm.prank(owner); router.setPaused(false);
        vm.warp(1000); vm.prank(user); vm.expectRevert(RookeryRouter.Expired.selector);
        router.buy{value: 1 ether}(address(pad), abi.encodeWithSelector(MockPad.buy.selector, address(tok), 0), address(tok), 0, user, 999);
        vm.prank(owner); vm.expectRevert(bytes("cap")); router.setFee(101, sink);
        vm.prank(user); vm.expectRevert(RookeryRouter.NotOwner.selector); router.setFee(0, user);
        vm.prank(user); vm.expectRevert(RookeryRouter.NotOwner.selector); router.setPaused(true);
        address[] memory t = new address[](1); bytes4[] memory s = new bytes4[](1); uint8[] memory d = new uint8[](1);
        (t[0], s[0], d[0]) = (user, bytes4(0x12345678), 1);
        vm.prank(user); vm.expectRevert(RookeryRouter.NotOwner.selector); router.setAllowed(t, s, d);
        vm.prank(owner); vm.expectRevert(RookeryRouter.BadTarget.selector); router.setAllowed(t, s, d);   // EOA target
        vm.prank(owner); router.proposeOwner(other);
        vm.prank(other); router.acceptOwner(); assertEq(router.owner(), other);
    }

    function testFuzz_fee_exact(uint96 v) public {
        vm.assume(v > 1e6 && v < 50 ether);
        uint256 out = _buy(v, 0);
        uint256 fee = (uint256(v) * 50) / 10000;
        assertEq(sink.balance, fee); assertEq(out, (uint256(v) - fee) * 1000);
    }
}
