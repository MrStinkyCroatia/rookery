// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct SendParam {
    uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD;
    bytes extraOptions; bytes composeMsg; bytes oftCmd;
}
struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }

interface IOFTBridge {
    function quoteSend(SendParam calldata p, bool payInLzToken) external view returns (MessagingFee memory);
    function send(SendParam calldata p, MessagingFee calldata fee, address refundAddress) external payable returns (bytes32, uint64, MessagingFee memory);
}
interface IERC20Bridge {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @title ZroAutoBridge
/// @notice ZRO -> Zero (LayerZero EID 33002), to the sender's OWN address on Zero, through ZRO's own LayerZero contract.
///
///         Two ways in:
///         · bridgeNow: one transaction while the route is open (after a one-time approval). Pulls the ZRO, takes the
///           manual fee, sends through the OFT and refunds the unused native in the same call.
///         · signUp: for the short, unannounced windows LayerZero opens. The ZRO stays in the wallet; when the route
///           opens anyone may call fire/fireMany (our bot does it within a block or two), and the contract itself asks
///           LayerZero that the route is open (quoteSend must succeed) before anything moves.
///
///         The destination is always derived from the user's address, never taken from an argument, so no one (the
///         operator included) can send the tokens anywhere else. Nothing is held after a transaction: bridged ZRO goes
///         into the OFT, the fee to the fee sink, and the rest of the native deposit back to the user. Cancel anytime.
contract ZroAutoBridge {
    uint16 public constant MAX_FEE_BPS = 200;          // 2% hard cap on both fees
    uint32 public immutable dstEid;
    address public immutable oft;
    address public immutable zro;

    address public owner;
    address public feeSink;
    uint16 public feeBps = 50;                          // auto-bridge: 0.5%, only when it fires
    uint16 public manualFeeBps = 30;                    // bridgeNow: 0.3%
    bool public paused;
    uint256 private locked = 1;

    struct Order { uint256 amount; uint256 deposit; uint256 maxGasPrice; bool active; uint64 signedAt; }
    mapping(address => Order) public orders;
    address[] public signers;
    mapping(address => uint256) private signerIndex;    // 1-based position in signers, 0 = none

    event SignedUp(address indexed user, uint256 amount, uint256 deposit, uint256 maxGasPrice, bytes32 to);
    event Fired(address indexed user, uint256 bridged, uint256 fee, uint256 nativeFee, uint256 refund, bytes32 guid);
    event Bridged(address indexed user, uint256 bridged, uint256 fee, uint256 nativeFee, uint256 refund, bytes32 guid);
    event Cancelled(address indexed user, uint256 deposit);
    event FeeSet(uint16 autoBps, uint16 manualBps, address sink);
    event Paused(bool on);
    event OwnerChanged(address indexed to);

    error NotOwner();
    error IsPaused();
    error NoOrder();
    error Zero();
    error RouteClosed();
    error GasTooHigh();
    error NoAllowance();
    error NotEnoughZro();
    error DepositTooLow();
    error SettlementFailed();
    error Reentrancy();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() { if (locked != 1) revert Reentrancy(); locked = 2; _; locked = 1; }

    constructor(address _owner, address _feeSink, address _oft, address _zro, uint32 _dstEid) {
        if (_owner == address(0) || _feeSink == address(0) || _oft == address(0) || _zro == address(0)) revert Zero();
        owner = _owner; feeSink = _feeSink; oft = _oft; zro = _zro; dstEid = _dstEid;
        emit FeeSet(feeBps, manualFeeBps, _feeSink);
    }

    // ------------------------------------------------------------------ manual: one transaction

    /// @notice bridge `amount` ZRO to your own address on Zero right now (needs a prior approval and an open route).
    ///         Send LayerZero's fee as msg.value (quote it with quote()); the unused part comes back.
    function bridgeNow(uint256 amount) external payable nonReentrant returns (bytes32 guid) {
        if (paused) revert IsPaused();
        (uint256 bridged, uint256 fee, uint256 nf, bytes32 g) = _bridge(msg.sender, amount, msg.value, manualFeeBps);
        guid = g;
        uint256 refund = msg.value - nf;
        if (refund > 0) _sendNative(msg.sender, refund);
        emit Bridged(msg.sender, bridged, fee, nf, refund, guid);
    }

    // ------------------------------------------------------------------ auto: sign up once, fires in the window

    /// @notice sign up to bridge `amount` ZRO when the route opens; the native deposit covers LayerZero's fee.
    /// @dev needs approve(this, amount) first. Calling again updates the amount and adds to the deposit.
    function signUp(uint256 amount, uint256 maxGasPrice) external payable nonReentrant {
        if (paused) revert IsPaused();
        if (amount == 0) revert Zero();
        if (msg.value == 0) revert DepositTooLow();
        if (IERC20Bridge(zro).allowance(msg.sender, address(this)) < amount) revert NoAllowance();
        Order storage o = orders[msg.sender];
        if (!o.active) {
            o.active = true; o.signedAt = uint64(block.timestamp);
            signers.push(msg.sender); signerIndex[msg.sender] = signers.length;
        }
        o.amount = amount;
        o.deposit += msg.value;
        o.maxGasPrice = maxGasPrice;
        emit SignedUp(msg.sender, amount, o.deposit, maxGasPrice, _toBytes32(msg.sender));
    }

    /// @notice cancel anytime: the whole deposit comes back (the ZRO never left the wallet)
    function cancel() external nonReentrant {
        Order storage o = orders[msg.sender];
        if (!o.active) revert NoOrder();
        uint256 dep = o.deposit;
        _removeSigner(msg.sender);
        delete orders[msg.sender];
        if (dep > 0) _sendNative(msg.sender, dep);
        emit Cancelled(msg.sender, dep);
    }

    /// @notice bridge one ready order while the route is open. Anyone may call this.
    function fire(address user) public nonReentrant returns (bytes32 guid) {
        if (paused) revert IsPaused();
        Order memory o = orders[user];
        if (!o.active) revert NoOrder();
        if (o.maxGasPrice != 0 && tx.gasprice > o.maxGasPrice) revert GasTooHigh();
        _removeSigner(user);
        delete orders[user];                                            // effects before any external call
        (uint256 bridged, uint256 fee, uint256 nf, bytes32 g) = _bridge(user, o.amount, o.deposit, feeBps);
        guid = g;
        uint256 refund = o.deposit - nf;
        if (refund > 0) _sendNative(user, refund);
        emit Fired(user, bridged, fee, nf, refund, guid);
    }

    /// @notice fire many orders in one transaction; orders that are not ready are skipped untouched
    function fireMany(address[] calldata users) external returns (uint256 done) {
        for (uint256 i; i < users.length; i++) {
            try this.fire(users[i]) { done++; } catch { /* closed, moved tokens, gas cap: stays signed up */ }
        }
    }

    // ------------------------------------------------------------------ views

    /// @notice LayerZero's native fee for bridging `amount` now; reverts with RouteClosed while the route is closed
    function quote(address user, uint256 amount, bool manual) external view returns (uint256 nativeFee, uint256 bridged, uint256 fee) {
        fee = (amount * (manual ? manualFeeBps : feeBps)) / 10000;
        bridged = (amount - fee) / 1e12 * 1e12;
        try IOFTBridge(oft).quoteSend(_param(user, bridged), false) returns (MessagingFee memory f) { nativeFee = f.nativeFee; }
        catch { revert RouteClosed(); }
    }

    function pending() external view returns (address[] memory list) {
        uint256 n;
        for (uint256 i; i < signers.length; i++) if (orders[signers[i]].active) n++;
        list = new address[](n);
        uint256 k;
        for (uint256 i; i < signers.length; i++) { address s = signers[i]; if (orders[s].active) list[k++] = s; }
    }

    function orderOf(address user) external view returns (Order memory) { return orders[user]; }

    // ------------------------------------------------------------------ admin

    function setFees(uint16 autoBps, uint16 manualBps, address sink) external onlyOwner {
        require(autoBps <= MAX_FEE_BPS && manualBps <= MAX_FEE_BPS, "cap");
        if (sink == address(0)) revert Zero();
        feeBps = autoBps; manualFeeBps = manualBps; feeSink = sink;
        emit FeeSet(autoBps, manualBps, sink);
    }
    function setPaused(bool on) external onlyOwner { paused = on; emit Paused(on); }
    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert Zero();
        owner = to; emit OwnerChanged(to);
    }
    /// @notice recover native sent here by mistake; signed-up deposits are only paid out through fire/cancel
    function rescue(address to, uint256 amount) external onlyOwner {
        uint256 held;
        for (uint256 i; i < signers.length; i++) held += orders[signers[i]].deposit;
        require(address(this).balance - amount >= held, "deposits");
        _sendNative(to, amount);
    }

    // ------------------------------------------------------------------ internals

    function _param(address user, uint256 bridged) internal view returns (SendParam memory) {
        return SendParam({ dstEid: dstEid, to: _toBytes32(user), amountLD: bridged, minAmountLD: bridged,
            extraOptions: "", composeMsg: "", oftCmd: "" });
    }

    function _bridge(address user, uint256 amount, uint256 nativeIn, uint16 bps)
        internal returns (uint256 bridged, uint256 fee, uint256 nf, bytes32 guid)
    {
        if (amount == 0) revert Zero();
        fee = (amount * bps) / 10000;
        bridged = (amount - fee) / 1e12 * 1e12;                         // OFT shared decimals = 6: no dust is sent
        if (bridged == 0) revert Zero();
        SendParam memory p = _param(user, bridged);                     // destination: the user's own address
        MessagingFee memory q;
        try IOFTBridge(oft).quoteSend(p, false) returns (MessagingFee memory f) { q = f; } catch { revert RouteClosed(); }
        if (q.nativeFee > nativeIn) revert DepositTooLow();
        nf = q.nativeFee;
        // pull exactly what leaves the wallet (bridged + fee); rounding dust below 1e12 stays with the user
        if (IERC20Bridge(zro).balanceOf(user) < bridged + fee) revert NotEnoughZro();
        if (!IERC20Bridge(zro).transferFrom(user, address(this), bridged + fee)) revert NotEnoughZro();
        if (fee > 0 && !IERC20Bridge(zro).transfer(feeSink, fee)) revert SettlementFailed();
        _approveOft(bridged);
        (guid, , ) = IOFTBridge(oft).send{ value: nf }(p, q, user);    // the OFT pulls what it bridges from here
        _approveOft(0);
    }

    function _toBytes32(address a) internal pure returns (bytes32) { return bytes32(uint256(uint160(a))); }

    function _approveOft(uint256 amount) internal {
        (bool ok, bytes memory r) = zro.call(abi.encodeWithSelector(0x095ea7b3, oft, amount));
        if (!ok || (r.length > 0 && !abi.decode(r, (bool)))) revert SettlementFailed();
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{ value: amount }("");
        if (!ok) revert SettlementFailed();
    }

    function _removeSigner(address user) internal {
        uint256 idx = signerIndex[user];
        if (idx == 0) return;
        uint256 last = signers.length;
        if (idx != last) { address moved = signers[last - 1]; signers[idx - 1] = moved; signerIndex[moved] = idx; }
        signers.pop();
        signerIndex[user] = 0;
    }

    receive() external payable { if (locked != 2) revert Zero(); }
}
