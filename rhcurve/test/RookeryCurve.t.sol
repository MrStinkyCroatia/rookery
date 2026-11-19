// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {RookeryCurve, IUniswapV3Factory, IUniswapV3Pool} from "../src/RookeryCurve.sol";
import {RookeryToken} from "../src/RookeryToken.sol";

interface INPM {
    function ownerOf(uint256) external view returns (address);
    function createAndInitializePoolIfNecessary(address, address, uint24, uint160) external payable returns (address);
}
interface ISwapRouter02 {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract Evil {
    RookeryCurve c;
    constructor(RookeryCurve _c) { c = _c; }
    function poke() external { c.uniswapV3SwapCallback(1 ether, 0, ""); }
    function token0() external view returns (address) { return address(c.weth()); }
}

contract SmartAccount { receive() external payable {} }

contract RookeryCurveTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    RookeryCurve curve;
    address feeTo = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.createSelectFork("rh");
        curve = new RookeryCurve(WETH, FACTORY, NPM, feeTo, 2.4 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _launch() internal returns (RookeryToken t) {
        vm.prank(alice);
        t = RookeryToken(curve.create{value: 0.1 ether}("Penguin Test", "PNGT", 0));
    }

    function test_create_lands_in_wallet() public {
        RookeryToken t = _launch();
        assertGt(t.balanceOf(alice), 0, "creator holds the first buy in her wallet");
        assertEq(t.totalSupply(), 1_000_000_000 ether);
        assertEq(curve.tokensCount(), 1);
        (address creator,,,,,,,) = curve.curves(address(t));
        assertEq(creator, alice);
    }

    function test_buy_sell_quotes_and_fees() public {
        RookeryToken t = _launch();
        uint256 q = curve.quoteBuy(address(t), 1 ether);
        vm.prank(bob);
        uint256 got = curve.buy{value: 1 ether}(address(t), q);
        assertEq(got, q, "buy matches the quote");
        assertEq(t.balanceOf(bob), got);
        uint256 qs = curve.quoteSell(address(t), got / 2);
        uint256 before = bob.balance;
        vm.prank(bob);
        uint256 out = curve.sell(address(t), got / 2, qs);   // one signature: no approve needed
        assertEq(out, qs, "sell matches the quote");
        assertEq(bob.balance - before, out);
        assertGt(curve.feesAccrued(), 0);
        curve.claimFees();
        assertGt(feeTo.balance, 0, "fees reach the fee address");
    }

    function test_slippage_reverts() public {
        RookeryToken t = _launch();
        uint256 q = curve.quoteBuy(address(t), 1 ether);
        vm.prank(bob);
        vm.expectRevert(RookeryCurve.Slippage.selector);
        curve.buy{value: 1 ether}(address(t), q + 1);
    }

    function test_no_contracts_before_launch() public {
        RookeryToken t = _launch();
        uint256 bal = t.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(RookeryToken.NoContractsBeforeLaunch.selector);
        t.transfer(WETH, 1);                                 // a contract (could be a pool)
        vm.prank(alice);
        t.transfer(bob, bal / 2);                            // wallets are fine
        assertEq(t.balanceOf(bob), bal / 2);
    }

    function test_eip7702_wallets_can_buy_and_receive() public {
        RookeryToken t = _launch();
        address smart = address(0x7702);
        vm.etch(smart, abi.encodePacked(hex"ef0100", address(new SmartAccount())));
        vm.deal(smart, 1 ether);
        vm.prank(smart);
        uint256 got = curve.buy{value: 0.1 ether}(address(t), 0);
        assertEq(t.balanceOf(smart), got, "7702 wallet buys");
        vm.prank(alice);
        t.transfer(smart, 1);
        vm.prank(smart);
        curve.sell(address(t), got, 0);
    }

    function _fill(RookeryToken t) internal {
        // buy until the curve sells out; the last buy gets its extra ETH back
        vm.deal(bob, 1000 ether);
        uint256 before = bob.balance;
        vm.prank(bob);
        curve.buy{value: 100 ether}(address(t), 0);
        (,,,,, bool complete,,) = curve.curves(address(t));
        assertTrue(complete, "sold out");
        assertLt(before - bob.balance, 100 ether, "extra ETH refunded");
    }

    function test_graduation_to_uniswap_lp_burned() public {
        RookeryToken t = _launch();
        _fill(t);
        vm.expectRevert(RookeryCurve.CurveClosed.selector);
        vm.prank(bob);
        curve.buy{value: 1 ether}(address(t), 0);
        uint256 endPrice = curve.price(address(t));
        address pool = curve.graduate(address(t));
        assertTrue(pool != address(0));
        assertTrue(t.launched(), "free transfers after graduation");
        assertGt(IUniswapV3Pool(pool).liquidity(), 0, "pool has liquidity");
        // pool price ~= curve end price
        (uint160 s,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 p = _poolPrice(address(t), s);
        assertApproxEqRel(p, endPrice, 0.02e18, "pool opens at the curve price");
        // swap on Uniswap works
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        uint256 out = ISwapRouter02(ROUTER).exactInputSingle{value: 0.5 ether}(ISwapRouter02.ExactInputSingleParams({
            tokenIn: WETH, tokenOut: address(t), fee: 10000, recipient: alice, amountIn: 0.5 ether, amountOutMinimum: 1, sqrtPriceLimitX96: 0 }));
        assertGt(out, 0, "trades on Uniswap after graduation");
        vm.expectRevert(RookeryCurve.NotComplete.selector);
        curve.graduate(address(t));
    }

    function test_frontrun_pool_cannot_break_graduation() public {
        RookeryToken t = _launch();
        // attacker opens the pool early at an absurd price
        (address a, address b) = address(t) < WETH ? (address(t), WETH) : (WETH, address(t));
        INPM(NPM).createAndInitializePoolIfNecessary(a, b, 10000, uint160(1) << 120);
        _fill(t);
        uint256 endPrice = curve.price(address(t));
        address pool = curve.graduate(address(t));
        (uint160 s,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertApproxEqRel(_poolPrice(address(t), s), endPrice, 0.02e18, "price restored to the curve price");
    }

    function test_lp_nft_goes_to_dead() public {
        RookeryToken t = _launch();
        _fill(t);
        vm.recordLogs();
        curve.graduate(address(t));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 tokenId;
        bytes32 sig = keccak256("Graduated(address,address,uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) if (logs[i].topics[0] == sig) (, tokenId,,,) = abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256));
        assertEq(INPM(NPM).ownerOf(tokenId), curve.DEAD(), "LP owned by the dead address");
    }

    function test_callback_guard() public {
        Evil e = new Evil(curve);
        vm.deal(address(curve), 1 ether);
        vm.expectRevert(bytes("no"));
        e.poke();
    }

    function test_owner_cannot_touch_curves() public {
        RookeryToken t = _launch();
        vm.prank(bob);
        vm.expectRevert(RookeryCurve.NotOwner.selector);
        curve.setFeeBps(100);
        curve.setFeeBps(100);                                 // owner: only up to 1%, future trades
        vm.expectRevert(bytes("max 1%"));
        curve.setFeeBps(101);
        (, , uint128 realEth,,,,,) = curve.curves(address(t));
        assertGt(realEth, 0);
    }

    /// any sequence of buys and sells: everyone can always sell everything back, and the contract
    /// always holds at least the curve ETH plus the fees it owes
    function testFuzz_solvency(uint96[6] memory amts, bool[6] memory sides) public {
        RookeryToken t = _launch();
        address[3] memory who = [alice, bob, address(0xCAFE)];
        vm.deal(address(0xCAFE), 100 ether);
        for (uint256 i; i < 6; i++) {
            address u = who[i % 3];
            if (sides[i] || t.balanceOf(u) == 0) {
                uint256 e = bound(uint256(amts[i]), 0.001 ether, 3 ether);
                vm.prank(u); curve.buy{value: e}(address(t), 0);
                (,,,,, bool complete,,) = curve.curves(address(t));
                if (complete) return;
            } else {
                uint256 a = bound(uint256(amts[i]), 1, t.balanceOf(u));
                vm.prank(u); curve.sell(address(t), a, 0);
            }
            (, , uint128 realEth,,,,,) = curve.curves(address(t));
            assertGe(address(curve).balance, uint256(realEth) + curve.feesAccrued(), "solvent");
        }
        for (uint256 j; j < 3; j++) {
            uint256 b = t.balanceOf(who[j]);
            if (b > 0) { vm.prank(who[j]); curve.sell(address(t), b, 0); }
        }
        (, , uint128 left, uint128 sold,,,,) = curve.curves(address(t));
        assertEq(sold, 0, "all sold back");
        assertGe(address(curve).balance, uint256(left) + curve.feesAccrued(), "solvent after full exit");
    }

    function _poolPrice(address token, uint160 s) internal pure returns (uint256) {
        // ETH per token, 1e18 scaled
        uint256 p = (((uint256(s) * uint256(s)) >> 96) * 1e18) >> 96;  // token1 per token0
        if (token < WETH) return p;                                   // token0 = token, token1 = WETH
        return (1e36) / p;
    }
}
