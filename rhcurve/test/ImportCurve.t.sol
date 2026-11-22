// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {RookeryCurve2, RookeryTokenDeployer} from "../src/RookeryCurve2.sol";
import {RookeryToken2} from "../src/RookeryToken2.sol";

/// 1:1 migration of Rookery pre-market curves to Zero (native ZRO pair). No fork: import never touches WETH/Uniswap.
contract ImportCurveTest is Test {
    RookeryCurve2 curve;
    address feeTo = address(0xFEE);
    address custody = address(0xC0570D1);   // Rookery hot wallet (EOA)
    address creator = address(0xC2EA);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 constant V = 1_073_000_000 ether;
    uint256 constant VQ = 3150 ether;        // ledger v_zro of a Zero market

    receive() external payable {}

    function setUp() public {
        curve = new RookeryCurve2(address(0x1001), address(0x1002), address(0x1003), feeTo, VQ);
        vm.deal(address(this), 100_000 ether);
        vm.deal(bob, 10_000 ether);
    }

    function _divUp(uint256 a, uint256 b) internal pure returns (uint256) { return (a + b - 1) / b; }
    function _real(uint256 sold) internal pure returns (uint256) { return sold == 0 ? 0 : _divUp(VQ * V, V - sold) - VQ; }

    // real numbers of a prod market (TZRO-like): 280.47M held, 1.55M burned
    function _import(uint256 sold, uint256 burned, uint256 sendExtra) internal returns (RookeryToken2 t) {
        uint256 need = _real(sold);
        t = RookeryToken2(curve.importCurve{value: need + sendExtra}("Merlin", "MERLIN", creator, 100, 50, 0, VQ, sold, burned, custody, "merlin-1a2b3c"));
    }

    function test_import_state_matches_ledger() public {
        uint256 sold = 282_019_823.28 ether;
        uint256 burned = 1_548_508.67 ether;
        uint256 bal0 = address(this).balance;
        RookeryToken2 t = _import(sold, burned, 5 ether);
        (address cr, address q, uint128 vq, uint128 real, uint128 s,, bool complete,,) = curve.curves(address(t));
        assertEq(cr, creator); assertEq(q, address(0)); assertEq(vq, VQ); assertEq(s, sold); assertFalse(complete);
        assertEq(real, _real(sold), "reserve from the invariant");
        assertEq(address(curve).balance, real, "curve holds exactly the reserve");
        assertEq(bal0 - address(this).balance, real, "excess refunded");
        assertEq(t.balanceOf(custody), sold - burned, "holders' tokens in custody 1:1");
        assertEq(t.totalSupply(), 1_000_000_000 ether - burned, "burned stays burned");
        assertEq(t.balanceOf(address(curve)), 1_000_000_000 ether - sold, "curve keeps unsold + reserve");
        assertEq(t.creator(), creator);
    }

    function test_price_continues_exactly() public {
        uint256 sold = 150_000_000 ether;
        RookeryToken2 t = _import(sold, 0, 0);
        // ledger: z = vQ + reserve, t = V - sold, tokens out = t - k/(z + net); fee 0.5% + marketing 1%, burn 0.5%
        uint256 inQ = 10 ether;
        uint256 net = inQ - (inQ * 150) / 10000;
        uint256 x = VQ + _real(sold);
        uint256 y = V - sold;
        uint256 gross = y - _divUp(VQ * V, x + net);
        uint256 expected = gross - (gross * 50) / 10000;
        assertEq(curve.quoteBuy(address(t), inQ), expected, "on-chain quote == ledger formula");
        vm.prank(bob); uint256 got = curve.buy{value: inQ}(address(t), 0, expected);
        assertEq(got, expected);
    }

    function test_every_holder_can_exit_after_withdrawal() public {
        uint256 sold = 200_000_000 ether;
        uint256 burned = 1_000_000 ether;
        RookeryToken2 t = _import(sold, burned, 0);
        // Rookery pays out withdrawals from custody; holders then sell on the curve
        vm.startPrank(custody); t.transfer(alice, 120_000_000 ether); t.transfer(bob, 79_000_000 ether); vm.stopPrank();
        uint256 a0 = alice.balance;
        vm.prank(alice); curve.sell(address(t), 120_000_000 ether, 0);
        assertGt(alice.balance, a0);
        vm.prank(bob); curve.sell(address(t), 79_000_000 ether, 0);
        (,,, uint128 real,,,,,) = curve.curves(address(t));
        assertLe(real, address(curve).balance, "reserve always covered");
    }

    function test_curve_completes_on_import_at_cap() public {
        RookeryToken2 t = _import(800_000_000 ether, 0, 0);
        (,,,,,, bool complete,,) = curve.curves(address(t));
        assertTrue(complete);
    }

    function test_only_owner_and_full_reserve() public {
        uint256 sold = 100_000_000 ether;
        uint256 need = _real(sold);
        vm.deal(alice, need);
        vm.prank(alice);
        vm.expectRevert(RookeryCurve2.NotOwner.selector);
        curve.importCurve{value: need}("X", "X", creator, 0, 0, 0, VQ, sold, 0, custody, "x");
        vm.expectRevert(RookeryCurve2.Slippage.selector);
        curve.importCurve{value: need - 1}("X", "X", creator, 0, 0, 0, VQ, sold, 0, custody, "x");
        vm.expectRevert(RookeryCurve2.Zero.selector);
        curve.importCurve{value: need}("X", "X", creator, 0, 0, 0, VQ, sold, sold + 1, custody, "x");
    }

    function test_custody_must_be_an_eoa_before_launch() public {
        uint256 sold = 10_000_000 ether;
        uint256 need = _real(sold);
        vm.expectRevert();
        curve.importCurve{value: need}("X", "X", creator, 0, 0, 0, VQ, sold, 0, address(this), "x");
    }

    // ---------------------------------------------------------------- reserved (deterministic) addresses
    function _imp(string memory id, uint256 sold) internal returns (address) {
        return curve.importCurve{value: _real(sold)}("Tok", "TOK", creator, 0, 0, 0, VQ, sold, 0, custody, id);
    }

    function test_reserved_address_independent_of_order() public {
        address want = curve.predictImported("merlin-1a2b3c");
        _imp("bryan-77aa01", 10_000_000 ether);          // other tokens first, in any order
        _imp("pengu-0c0c0c", 5_000_000 ether);
        address got = _imp("merlin-1a2b3c", 1_000_000 ether);
        assertEq(got, want, "token lands on its reserved address");
        // the same prediction from a second curve with a different import order
        RookeryCurve2 c2 = new RookeryCurve2(address(0x1001), address(0x1002), address(0x1003), feeTo, VQ);
        assertTrue(c2.predictImported("merlin-1a2b3c") != want, "address is tied to the deployer");
    }

    function test_same_id_cannot_be_imported_twice() public {
        _imp("merlin-1a2b3c", 1_000_000 ether);
        vm.expectRevert();
        this.reimport();
    }
    function reimport() external { _imp("merlin-1a2b3c", 1_000_000 ether); }

    /// the worker computes: curve = CREATE(eoa, 0); deployer = CREATE(curve, 1); stub = CREATE2(deployer, keccak(id), STUB_HASH);
    /// token = CREATE(stub, 1). This test runs that exact formula against a real deployment from a fresh EOA.
    function test_offchain_formula_matches_fresh_eoa_deploy() public {
        address eoa = address(0xD3910E);
        vm.deal(eoa, 1000 ether);
        assertEq(vm.getNonce(eoa), 0);
        address predictedCurve = vm.computeCreateAddress(eoa, 0);
        vm.prank(eoa);
        RookeryCurve2 c = new RookeryCurve2(address(0x1001), address(0x1002), address(0x1003), feeTo, VQ);
        assertEq(address(c), predictedCurve, "curve = first deploy of the fresh wallet");
        address dep = vm.computeCreateAddress(address(c), 1);
        assertEq(address(c.deployer()), dep, "deployer = first deploy of the curve");
        bytes32 stubHash = RookeryTokenDeployer(dep).STUB_HASH();
        emit log_named_bytes32("STUB_HASH", stubHash);
        bytes32 salt = keccak256(bytes("merlin-1a2b3c"));
        address stub = vm.computeCreate2Address(salt, stubHash, dep);
        address token = vm.computeCreateAddress(stub, 1);
        uint256 need = _real(1_000_000 ether);
        vm.prank(eoa);
        address got = c.importCurve{value: need}("Merlin", "MERLIN", creator, 100, 50, 0, VQ, 1_000_000 ether, 0, custody, "merlin-1a2b3c");
        assertEq(got, token, "off-chain formula == on-chain address");
    }
}
