// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ZroAutoBridge.sol";

contract MockZro {
    string public name = "ZRO"; string public symbol = "ZRO"; uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { require(balanceOf[msg.sender] >= a); balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a && allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract MockOFT {
    MockZro public zro; uint256 public nativeFee = 0.001 ether; bool public closed; uint32 public lastDst; bytes32 public lastTo; uint256 public lastAmount;
    event Sent(bytes32 guid, uint32 dstEid, bytes32 to, uint256 amount);
    constructor(MockZro z) { zro = z; }
    function setFee(uint256 f) external { nativeFee = f; }
    function setClosed(bool c) external { closed = c; }
    function quoteSend(SendParam calldata, bool) external view returns (MessagingFee memory) {
        require(!closed, "Executor_EidNotSupported(33002)");
        return MessagingFee({ nativeFee: nativeFee, lzTokenFee: 0 });
    }
    function send(SendParam calldata p, MessagingFee calldata f, address) external payable returns (bytes32, uint64, MessagingFee memory) {
        require(msg.value >= f.nativeFee, "fee");
        require(zro.transferFrom(msg.sender, address(this), p.amountLD), "pull");
        lastDst = p.dstEid; lastTo = p.to; lastAmount = p.amountLD;
        bytes32 guid = keccak256(abi.encode(p.to, p.amountLD, block.number));
        emit Sent(guid, p.dstEid, p.to, p.amountLD);
        return (guid, 1, MessagingFee(0, 0));
    }
    receive() external payable {}
}

contract ZroAutoBridgeTest is Test {
    ZroAutoBridge br; MockZro zro; MockOFT oft;
    address owner = address(0xA11CE); address sink = address(0xB0B0); address user = address(0xCAFE); address other = address(0xD00D);
    uint32 constant ZERO_EID = 33002;

    function setUp() public {
        zro = new MockZro(); oft = new MockOFT(zro);
        br = new ZroAutoBridge(owner, sink, address(oft), address(zro), ZERO_EID);
        zro.mint(user, 1000 ether); zro.mint(other, 1000 ether);
        vm.deal(user, 10 ether); vm.deal(other, 10 ether);
        vm.prank(user); zro.approve(address(br), type(uint256).max);
        vm.prank(other); zro.approve(address(br), type(uint256).max);
    }

    function _sign(address who, uint256 amount, uint256 maxGas) internal {
        vm.prank(who); br.signUp{ value: 0.01 ether }(amount, maxGas);
    }

    function test_signup_records_and_lists() public {
        _sign(user, 100 ether, 0);
        ZroAutoBridge.Order memory o = br.orderOf(user);
        assertEq(o.amount, 100 ether); assertEq(o.deposit, 0.01 ether); assertTrue(o.active);
        address[] memory p = br.pending(); assertEq(p.length, 1); assertEq(p[0], user);
    }

    function test_signup_needs_allowance() public {
        vm.prank(other); zro.approve(address(br), 1 ether);
        vm.prank(other); vm.expectRevert(ZroAutoBridge.NoAllowance.selector);
        br.signUp{ value: 0.01 ether }(100 ether, 0);
    }

    function test_signup_twice_tops_up() public {
        _sign(user, 100 ether, 0);
        vm.prank(user); br.signUp{ value: 0.005 ether }(120 ether, 0);
        assertEq(br.orderOf(user).amount, 120 ether); assertEq(br.orderOf(user).deposit, 0.015 ether);
        assertEq(br.pending().length, 1);
    }

    function test_cancel_returns_deposit_and_delists() public {
        _sign(user, 100 ether, 0);
        uint256 b0 = user.balance;
        vm.prank(user); br.cancel();
        assertEq(user.balance, b0 + 0.01 ether); assertEq(br.pending().length, 0);
        assertEq(br.orderOf(user).deposit, 0);
        vm.prank(user); vm.expectRevert(ZroAutoBridge.NoOrder.selector); br.cancel();
    }

    function test_fire_reverts_when_route_closed() public {
        _sign(user, 100 ether, 0);
        oft.setClosed(true);
        vm.expectRevert(ZroAutoBridge.RouteClosed.selector); br.fire(user);
        assertEq(zro.balanceOf(user), 1000 ether);                       // nothing moved
        assertEq(br.orderOf(user).deposit, 0.01 ether);
    }

    function test_fire_respects_gas_cap() public {
        _sign(user, 100 ether, 10 gwei);
        vm.txGasPrice(20 gwei);
        vm.expectRevert(ZroAutoBridge.GasTooHigh.selector); br.fire(user);
    }

    function test_fire_bridges_to_the_signers_own_address() public {
        _sign(user, 100 ether, 0);
        uint256 u0 = user.balance; uint256 sink0 = zro.balanceOf(sink);
        bytes32 guid = br.fire(user);
        assertTrue(guid != bytes32(0));
        assertEq(oft.lastDst(), ZERO_EID);
        assertEq(oft.lastTo(), bytes32(uint256(uint160(user))), "destination is the signer");
        assertEq(oft.lastAmount(), 99.5 ether, "amount minus 0.5% fee");
        assertEq(zro.balanceOf(sink), sink0 + 0.5 ether, "fee in ZRO");
        assertEq(zro.balanceOf(user), 900 ether, "exactly the signed amount left the wallet");
        assertEq(user.balance, u0 + 0.009 ether, "deposit 0.01 minus the 0.001 fee came back");
        assertEq(br.orderOf(user).amount, 0);
        assertEq(br.pending().length, 0);
    }

    function test_fire_is_permissionless() public {
        _sign(user, 50 ether, 0);
        vm.prank(other); br.fire(user);                                  // anyone can trigger it
        assertEq(oft.lastTo(), bytes32(uint256(uint160(user))));
    }

    function test_fire_refunds_extra_deposit() public {
        _sign(user, 50 ether, 0);
        uint256 u0 = user.balance;
        br.fire(user);
        assertEq(user.balance, u0 + 0.009 ether, "deposit 0.01, fee 0.001, rest back");
        assertEq(address(br).balance, 0);
        assertEq(zro.balanceOf(address(br)), 0);
    }

    function test_fire_reverts_if_user_moved_the_tokens() public {
        _sign(user, 100 ether, 0);
        vm.prank(user); zro.transfer(other, 950 ether);            // 50 left, less than the signed 100
        vm.expectRevert(ZroAutoBridge.NotEnoughZro.selector); br.fire(user);
        assertEq(br.orderOf(user).deposit, 0.01 ether, "order untouched");
    }

    function test_fire_reverts_when_deposit_too_low() public {
        vm.prank(user); br.signUp{ value: 0.0001 ether }(10 ether, 0);
        oft.setFee(0.01 ether);
        vm.expectRevert(ZroAutoBridge.DepositTooLow.selector); br.fire(user);
    }

    function test_fireMany_skips_unready_and_fires_ready() public {
        _sign(user, 10 ether, 0);                                        // ready
        vm.prank(other); br.signUp{ value: 0.01 ether }(10 ether, 0);     // other has tokens too
        vm.prank(other); zro.transfer(address(0xdead), 1000 ether);        // now short of tokens
        address[] memory list = br.pending();
        uint256 done = br.fireMany(list);
        assertEq(done, 1);
        assertEq(oft.lastTo(), bytes32(uint256(uint160(user))));
        assertEq(br.pending().length, 1, "the other order is still there, untouched");
    }

    function test_cannot_fire_twice() public {
        _sign(user, 10 ether, 0);
        br.fire(user);
        vm.expectRevert(ZroAutoBridge.NoOrder.selector); br.fire(user);
    }

    function test_pause_blocks_and_owner_controls() public {
        _sign(user, 10 ether, 0);
        vm.prank(owner); br.setPaused(true);
        vm.expectRevert(ZroAutoBridge.IsPaused.selector); br.fire(user);
        vm.prank(user); vm.expectRevert(ZroAutoBridge.IsPaused.selector); br.signUp{ value: 0.01 ether }(1 ether, 0);
        vm.prank(owner); br.setPaused(false);
        vm.prank(owner); vm.expectRevert(bytes("cap")); br.setFees(201, 30, sink);
        vm.prank(user); vm.expectRevert(ZroAutoBridge.NotOwner.selector); br.setFees(0, 0, user);
        vm.prank(owner); br.setFees(10, 20, owner); assertEq(br.feeBps(), 10); assertEq(br.manualFeeBps(), 20);
        vm.prank(owner); br.transferOwnership(other); assertEq(br.owner(), other);
    }

    function test_no_native_accepted_outside() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(br).call{ value: 0.5 ether }(""); assertFalse(ok);
    }

    // ---------------------------------------------------------------- manual bridge, one transaction
    function test_bridgeNow_in_one_transaction() public {
        uint256 u0 = user.balance; uint256 sink0 = zro.balanceOf(sink);
        vm.prank(user); bytes32 guid = br.bridgeNow{ value: 0.005 ether }(100 ether);
        assertTrue(guid != bytes32(0));
        assertEq(oft.lastTo(), bytes32(uint256(uint160(user))), "own address on Zero");
        assertEq(oft.lastAmount(), 99.7 ether, "0.3% manual fee");
        assertEq(zro.balanceOf(sink) - sink0, 0.3 ether);
        assertEq(zro.balanceOf(user), 900 ether);
        assertEq(user.balance, u0 - 0.001 ether, "only LayerZero's fee, the rest came back in the same tx");
        assertEq(address(br).balance, 0); assertEq(zro.balanceOf(address(br)), 0);
    }

    function test_bridgeNow_closed_moves_nothing() public {
        oft.setClosed(true);
        uint256 u0 = user.balance;
        vm.prank(user); vm.expectRevert(ZroAutoBridge.RouteClosed.selector); br.bridgeNow{ value: 0.005 ether }(100 ether);
        assertEq(zro.balanceOf(user), 1000 ether); assertEq(user.balance, u0);
    }

    function test_bridgeNow_needs_enough_native() public {
        vm.prank(user); vm.expectRevert(ZroAutoBridge.DepositTooLow.selector); br.bridgeNow{ value: 0.0005 ether }(100 ether);
    }

    function test_quote_open_and_closed() public {
        (uint256 nf, uint256 bridged, uint256 fee) = br.quote(user, 100 ether, true);
        assertEq(nf, 0.001 ether); assertEq(bridged, 99.7 ether); assertEq(fee, 0.3 ether);
        (, bridged, fee) = br.quote(user, 100 ether, false);
        assertEq(bridged, 99.5 ether); assertEq(fee, 0.5 ether);
        oft.setClosed(true);
        vm.expectRevert(ZroAutoBridge.RouteClosed.selector); br.quote(user, 100 ether, true);
    }

    function test_rescue_cannot_touch_deposits() public {
        _sign(user, 10 ether, 0);
        vm.prank(owner); vm.expectRevert(bytes("deposits")); br.rescue(owner, 0.01 ether);
    }

    function testFuzz_amount_and_deposit(uint96 amount, uint96 deposit) public {
        amount = uint96(bound(amount, 1e18, 100 ether));
        deposit = 0.01 ether;
        _sign(user, amount, 0);
        uint256 fee = (uint256(amount) * 50) / 10000;
        uint256 bridged = (uint256(amount) - fee) / 1e12 * 1e12;
        br.fire(user);
        assertEq(oft.lastAmount(), bridged);
        assertLe(bridged + fee, uint256(amount), "never bridges more than was signed");
        assertLe(uint256(amount) - bridged - fee, 1e12, "dust only");
        assertEq(address(br).balance, 0);
        assertEq(zro.balanceOf(address(br)), 0);
    }
}
