// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {RookeryCurve2} from "../src/RookeryCurve2.sol";
interface IERC20 { function balanceOf(address) external view returns (uint256); function transfer(address, uint256) external returns (bool); function approve(address, uint256) external returns (bool); }
import {RookeryToken2} from "../src/RookeryToken2.sol";

interface IRouter02 {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to) external payable returns (uint256);
}
interface IPairV2 {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

contract RookeryCurve2Test is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FACTORY_V2 = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;     // Micron stock token
    address constant MU_HOLDER = 0x51C72848c68a965f66FA7a88855F9f7784502a7F;
    RookeryCurve2 curve;
    address feeTo = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    function setUp() public {
        vm.createSelectFork("rh");
        curve = new RookeryCurve2(WETH, FACTORY_V2, feeTo, 2.4 ether);
        address[] memory q = new address[](1); uint256[] memory v = new uint256[](1);
        q[0] = MU; v[0] = 10 ether;                          // ~ $4k of MU at ~$400
        curve.setQuotes(q, v);
        for (uint256 i; i < 3; i++) vm.deal([alice, bob, carol][i], 1000 ether);
    }

    function _launchEth(uint16 m, uint16 b, uint16 r) internal returns (RookeryToken2 t) {
        vm.prank(alice);
        t = RookeryToken2(curve.create{value: 0.1 ether}("Hood Penguin", "HPNG", address(0), m, b, r, 0, 0));
    }
    function _fundMu(address to, uint256 amt) internal {
        vm.prank(MU_HOLDER); IERC20(MU).transfer(to, amt);
    }

    function test_eth_curve_taxes() public {
        RookeryToken2 t = _launchEth(100, 50, 100);
        uint256 aliceTok = t.balanceOf(alice);
        assertGt(aliceTok, 0);
        uint256 supply0 = t.totalSupply();
        uint256 q = curve.quoteBuy(address(t), 1 ether);
        vm.prank(bob); uint256 got = curve.buy{value: 1 ether}(address(t), 0, q);
        assertEq(got, q, "buy = quote");
        assertEq(t.balanceOf(bob), got);
        assertLt(t.totalSupply(), supply0, "burn tax burned tokens");
        assertGt(t.pendingRewards(alice), 0, "alice earns rewards from bob's buy");
        assertGt(curve.creatorOwed(alice, address(0)), 0, "creator marketing in ETH");
        // sell
        uint256 qs = curve.quoteSell(address(t), got / 2);
        uint256 e0 = bob.balance;
        vm.prank(bob); uint256 out = curve.sell(address(t), got / 2, qs);
        assertEq(out, qs); assertEq(bob.balance - e0, out);
        // creator claims, alice claims rewards
        uint256 c0 = alice.balance;
        vm.prank(alice); curve.claimCreator(address(0));
        assertGt(alice.balance, c0);
        uint256 pend = t.pendingRewards(alice);
        vm.prank(alice); t.claim();
        assertEq(t.balanceOf(alice), aliceTok + pend, "rewards claimed into balance");
        curve.claimFees(address(0));
        assertGt(feeTo.balance, 0);
    }

    function test_wallet_transfers_untaxed() public {
        RookeryToken2 t = _launchEth(500, 500, 0);
        uint256 a = t.balanceOf(alice);
        vm.prank(alice); t.transfer(bob, a);
        assertEq(t.balanceOf(bob), a);
    }

    function test_bad_quote_and_taxes() public {
        vm.prank(alice); vm.expectRevert(RookeryCurve2.BadQuote.selector);
        curve.create("X", "X", address(0x1234), 0, 0, 0, 0, 0);
        vm.prank(alice); vm.expectRevert(RookeryCurve2.BadTax.selector);
        curve.create("X", "X", address(0), 501, 0, 0, 0, 0);
        vm.prank(alice); vm.expectRevert(RookeryCurve2.BadTax.selector);
        curve.create("X", "X", address(0), 500, 500, 100, 0, 0);
        vm.prank(alice); vm.expectRevert(RookeryCurve2.BadQuote.selector);
        curve.create{value: 1}("X", "X", MU, 0, 0, 0, 0, 0);
    }

    function test_stock_pair_curve() public {
        _fundMu(alice, 5 ether); _fundMu(bob, 20 ether);
        vm.startPrank(alice);
        IERC20(MU).approve(address(curve), type(uint256).max);
        RookeryToken2 t = RookeryToken2(curve.create("Micron Penguin", "MUPNG", MU, 100, 100, 100, 1 ether, 0));
        vm.stopPrank();
        assertGt(t.balanceOf(alice), 0, "dev buy paid in MU");
        vm.startPrank(bob);
        IERC20(MU).approve(address(curve), type(uint256).max);
        uint256 q = curve.quoteBuy(address(t), 2 ether);
        uint256 got = curve.buy(address(t), 2 ether, q);
        assertEq(got, q);
        uint256 mu0 = IERC20(MU).balanceOf(bob);
        uint256 qs = curve.quoteSell(address(t), got);
        uint256 out = curve.sell(address(t), got, qs);
        vm.stopPrank();
        assertEq(IERC20(MU).balanceOf(bob) - mu0, out, "paid back in MU");
        assertGt(curve.creatorOwed(alice, MU), 0, "creator earns MU");
    }

    function _fill(address token, address quote) internal {
        if (quote == address(0)) { vm.prank(carol); curve.buy{value: 200 ether}(token, 0, 0); }
        else { _fundMu(carol, 100 ether); vm.startPrank(carol); IERC20(MU).approve(address(curve), type(uint256).max); curve.buy(token, 100 ether, 0); vm.stopPrank(); }
        (,,,,,, bool complete,,) = curve.curves(token);
        assertTrue(complete, "sold out");
    }

    function test_graduation_v2_eth_and_dex_taxes() public {
        RookeryToken2 t = _launchEth(100, 100, 100);
        vm.prank(bob); curve.buy{value: 1 ether}(address(t), 0, 0);
        _fill(address(t), address(0));
        address pair = curve.graduate(address(t));
        assertTrue(t.launched() && t.pair() == pair);
        assertGt(IPairV2(pair).balanceOf(curve.DEAD()), 0, "LP minted to the dead address");
        assertEq(IPairV2(pair).totalSupply(), IPairV2(pair).balanceOf(curve.DEAD()) + 1000, "only dead + minimum liquidity");
        // DEX buy with ETH through the real router: taxes apply
        uint256 supply0 = t.totalSupply();
        uint256 creator0 = t.balanceOf(alice);
        uint256 bobPend0 = t.pendingRewards(bob);
        address[] memory path = new address[](2); path[0] = WETH; path[1] = address(t);
        vm.prank(carol);
        uint256 out = IRouter02(ROUTER).swapExactTokensForTokens{value: 0.5 ether}(0.5 ether, 1, path, carol);
        assertGt(out, 0, "bought on Uniswap V2");
        assertLt(t.totalSupply(), supply0, "burn tax on DEX buy");
        assertGt(t.balanceOf(alice), creator0, "marketing tax to creator in tokens");
        assertGt(t.pendingRewards(bob), bobPend0, "holders earn rewards from DEX trades");
        // DEX sell
        uint256 sellAmt = t.balanceOf(carol) / 10;
        vm.startPrank(carol);
        t.approve(ROUTER, type(uint256).max);
        path[0] = address(t); path[1] = WETH;
        uint256 w = IRouter02(ROUTER).swapExactTokensForTokens(sellAmt, 1, path, carol);
        vm.stopPrank();
        assertGt(w, 0, "sold on Uniswap V2 (fee-on-transfer path)");
        assertGt(IERC20(WETH).balanceOf(carol), 0);
    }

    function test_graduation_v2_stock_pair() public {
        _fundMu(alice, 5 ether);
        vm.startPrank(alice);
        IERC20(MU).approve(address(curve), type(uint256).max);
        RookeryToken2 t = RookeryToken2(curve.create("Micron Penguin", "MUPNG", MU, 50, 50, 50, 1 ether, 0));
        vm.stopPrank();
        _fill(address(t), MU);
        address pair = curve.graduate(address(t));
        (uint112 r0, uint112 r1,) = IPairV2(pair).getReserves();
        assertGt(r0, 0); assertGt(r1, 0);
        _fundMu(bob, 2 ether);
        vm.startPrank(bob);
        IERC20(MU).approve(ROUTER, type(uint256).max);
        address[] memory path = new address[](2); path[0] = MU; path[1] = address(t);
        uint256 out = IRouter02(ROUTER).swapExactTokensForTokens(1 ether, 1, path, bob);
        vm.stopPrank();
        assertGt(out, 0, "token/MU pool trades");
    }

    function test_frontrun_pair_donation_is_harmless() public {
        RookeryToken2 t = _launchEth(0, 0, 0);
        // attacker creates the pair early and donates WETH; the token itself cannot reach the pair before launch
        address p = IUniswapV2FactoryLike(FACTORY_V2).createPair(address(t), WETH);
        vm.deal(bob, 10 ether);
        vm.startPrank(bob);
        (bool ok,) = WETH.call{value: 1 ether}(abi.encodeWithSignature("deposit()"));
        require(ok);
        IERC20(WETH).transfer(p, 1 ether);
        vm.expectRevert(RookeryToken2.NoContractsBeforeLaunch.selector);
        t.transfer(p, 1);
        vm.stopPrank();
        _fill(address(t), address(0));
        curve.graduate(address(t));
        assertGt(IPairV2(p).balanceOf(curve.DEAD()), 0, "graduation still mints LP to dead");
    }

    function test_reward_overflow_guard() public {
        // only the creator's 1 wei is eligible: rewards are burned instead of blowing up the accumulator
        vm.prank(alice);
        RookeryToken2 t = RookeryToken2(curve.create("Tiny", "TNY", address(0), 0, 0, 500, 0, 0));
        vm.prank(bob); curve.buy{value: 0.01 ether}(address(t), 0, 0);
        vm.prank(bob); t.transfer(carol, 1);
        assertEq(t.accRewardPerToken(), 0, "first buy had nobody eligible: burned");
        vm.prank(carol); curve.buy{value: 50 ether}(address(t), 0, 0);
        assertLt(t.accRewardPerToken(), 1e42, "bounded");
        vm.prank(bob); t.transfer(alice, 1);
    }

    function test_callback_free_owner_limits() public {
        vm.prank(bob); vm.expectRevert(RookeryCurve2.NotOwner.selector);
        curve.setFeeBps(10);
        vm.expectRevert(bytes("max 1%"));
        curve.setFeeBps(101);
    }

    function testFuzz_solvency_with_taxes(uint96[6] memory amts, bool[6] memory sides, uint16 m, uint16 b, uint16 r) public {
        m = uint16(bound(m, 0, 500)); b = uint16(bound(b, 0, 500)); r = uint16(bound(r, 0, 1000 - uint256(m) - b > 500 ? 500 : 1000 - uint256(m) - b));
        RookeryToken2 t = _launchEth(m, b, r);
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 6; i++) {
            address u = who[i % 3];
            if (sides[i] || t.balanceOf(u) == 0) {
                uint256 e = bound(uint256(amts[i]), 0.001 ether, 3 ether);
                vm.prank(u); curve.buy{value: e}(address(t), 0, 0);
                (,,,,,, bool complete,,) = curve.curves(address(t));
                if (complete) return;
            } else {
                uint256 a = bound(uint256(amts[i]), 1, t.balanceOf(u));
                vm.prank(u); curve.sell(address(t), a, 0);
            }
            (,,, uint128 realQ,,,,,) = curve.curves(address(t));
            assertGe(address(curve).balance, uint256(realQ) + curve.feesAccrued(address(0)) + curve.creatorOwed(alice, address(0)), "solvent");
        }
        for (uint256 j; j < 3; j++) {
            vm.prank(who[j]); t.claim();
            uint256 bal = t.balanceOf(who[j]);
            if (bal > 0) { vm.prank(who[j]); curve.sell(address(t), bal, 0); }
        }
        (,,, uint128 left,,,,,) = curve.curves(address(t));
        assertGe(address(curve).balance, uint256(left) + curve.feesAccrued(address(0)) + curve.creatorOwed(alice, address(0)), "solvent after exit");
    }
}

interface IUniswapV2FactoryLike { function createPair(address, address) external returns (address); }
