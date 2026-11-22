// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RookeryRouter
/// @notice Lets users buy and sell tokens of third-party launchpads (bonding curves) and DEX pools from the Rookery
///         Terminal with their own wallet. The router takes a flat platform fee in the native coin (0.5% at launch,
///         hard-capped at 1%) on both buys and sells and forwards it to `feeSink`, which funds the $臭企鹅 buy & burn.
///
///         The router only calls (target, selector) pairs the owner allowlisted for that side. It never keeps user
///         funds after a call: bought tokens go to the recipient, unspent tokens are refunded, approvals are reset,
///         and the native proceeds of a sell are measured as a balance delta inside the same call.
///
///         Adapters (in the Rookery worker) build `data` for each launchpad: the buy function must deliver tokens to
///         this router (msg.sender or an explicit recipient = router), the sell function must pull tokens from this
///         router via transferFrom and pay native back to it.
contract RookeryRouter {
    uint16 public constant MAX_FEE_BPS = 100;   // 1% hard cap
    uint8 internal constant BUY = 1;
    uint8 internal constant SELL = 2;

    address public owner;
    address public pendingOwner;
    address public feeSink;
    uint16 public feeBps = 50;
    bool public paused;
    uint256 private locked = 1;

    /// target => selector => side mask (1 = buy, 2 = sell, 3 = both)
    mapping(address => mapping(bytes4 => uint8)) public allowed;

    event Bought(address indexed user, address indexed token, address indexed target, address to, uint256 nativeIn, uint256 fee, uint256 tokensOut);
    event Sold(address indexed user, address indexed token, address indexed target, address to, uint256 tokensIn, uint256 nativeOut, uint256 fee);
    event Allowed(address indexed target, bytes4 indexed selector, uint8 sides);
    event FeeSet(uint16 bps, address sink);
    event Paused(bool on);
    event OwnerProposed(address indexed to);
    event OwnerChanged(address indexed to);

    error NotOwner();
    error IsPaused();
    error Expired();
    error NotAllowed();
    error BadTarget();
    error Slippage();
    error CallFailed(bytes reason);
    error TransferFailed();
    error Zero();
    error Reentrancy();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier live(uint256 deadline) {
        if (paused) revert IsPaused();
        if (block.timestamp > deadline) revert Expired();
        _;
    }
    modifier nonReentrant() { if (locked != 1) revert Reentrancy(); locked = 2; _; locked = 1; }

    constructor(address _owner, address _feeSink) {
        if (_owner == address(0) || _feeSink == address(0)) revert Zero();
        owner = _owner;
        feeSink = _feeSink;
        emit FeeSet(feeBps, _feeSink);
    }

    // ------------------------------------------------------------------ trading

    /// @param target  allowlisted launchpad curve / DEX router
    /// @param data    calldata for target (built by the Rookery adapter); receives msg.value minus the fee
    /// @param token   token being bought
    /// @param minOut  minimum tokens the router must receive (after the platform fee and the launchpad's own fees)
    /// @param to      recipient of the tokens
    function buy(address target, bytes calldata data, address token, uint256 minOut, address to, uint256 deadline)
        external payable nonReentrant live(deadline) returns (uint256 out)
    {
        if (msg.value == 0 || to == address(0)) revert Zero();
        _check(target, token, data, BUY);
        uint256 fee = (msg.value * feeBps) / 10000;
        uint256 n0 = address(this).balance - msg.value;           // native the router held before this call (normally 0)
        uint256 b0 = _bal(token, address(this));
        _call(target, msg.value - fee, data);
        uint256 got = _bal(token, address(this)) - b0;
        if (got == 0) revert Slippage();
        uint256 r0 = _bal(token, to);
        _sendToken(token, to, got);
        out = _bal(token, to) - r0;                                 // what the recipient really holds (transfer taxes)
        if (out < minOut) revert Slippage();
        _sendNative(feeSink, fee);
        // a launchpad may refund unspent native (curve filled up): hand it back to the user
        uint256 refund = address(this).balance - n0;
        if (refund > 0) _sendNative(msg.sender, refund);
        emit Bought(msg.sender, token, target, to, msg.value - refund, fee, out);
    }

    /// @param amount  tokens pulled from the user; `data` must sell at most what the router received
    /// @param minOut  minimum native the user receives after the platform fee
    function sell(address target, bytes calldata data, address token, uint256 amount, uint256 minOut, address payable to, uint256 deadline)
        external nonReentrant live(deadline) returns (uint256 net)
    {
        if (amount == 0 || to == address(0)) revert Zero();
        _check(target, token, data, SELL);
        uint256 t0 = _bal(token, address(this));
        _pullToken(token, msg.sender, amount);
        uint256 got = _bal(token, address(this)) - t0;               // fee-on-transfer tokens deliver less
        uint256 n0 = address(this).balance;
        _approve(token, target, got);
        _call(target, 0, data);
        _approve(token, target, 0);
        uint256 gross = address(this).balance - n0;
        uint256 fee = (gross * feeBps) / 10000;
        net = gross - fee;
        if (net < minOut || gross == 0) revert Slippage();
        uint256 left = _bal(token, address(this)) - t0;              // unsold tokens go back to the user
        if (left > 0) _sendToken(token, msg.sender, left);
        _sendNative(feeSink, fee);
        _sendNative(to, net);
        emit Sold(msg.sender, token, target, to, got - left, net, fee);
    }

    // ------------------------------------------------------------------ admin

    function setAllowed(address[] calldata targets, bytes4[] calldata selectors, uint8[] calldata sides) external onlyOwner {
        require(targets.length == selectors.length && targets.length == sides.length, "len");
        for (uint256 i; i < targets.length; i++) {
            if (targets[i] == address(this) || targets[i].code.length == 0) revert BadTarget();
            require(sides[i] <= 3, "sides");
            allowed[targets[i]][selectors[i]] = sides[i];
            emit Allowed(targets[i], selectors[i], sides[i]);
        }
    }

    function setFee(uint16 bps, address sink) external onlyOwner {
        require(bps <= MAX_FEE_BPS, "cap");
        if (sink == address(0)) revert Zero();
        feeBps = bps; feeSink = sink;
        emit FeeSet(bps, sink);
    }

    function setPaused(bool on) external onlyOwner { paused = on; emit Paused(on); }

    function proposeOwner(address to) external onlyOwner { pendingOwner = to; emit OwnerProposed(to); }
    function acceptOwner() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = pendingOwner; pendingOwner = address(0);
        emit OwnerChanged(owner);
    }

    /// @notice recover tokens or native sent to the router by mistake (never part of a trade: trades settle in-call)
    function rescue(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0)) _sendNative(to, amount); else _sendToken(token, to, amount);
    }

    receive() external payable {
        // launchpads / DEX routers pay sell proceeds and refunds here; only accepted while a trade is executing
        if (locked != 2) revert NotAllowed();
    }

    // ------------------------------------------------------------------ internals

    function _check(address target, address token, bytes calldata data, uint8 side) internal view {
        if (target == token || target == address(this) || data.length < 4) revert BadTarget();
        if (allowed[target][bytes4(data[:4])] & side == 0) revert NotAllowed();
    }

    function _call(address target, uint256 value, bytes calldata data) internal {
        (bool ok, bytes memory r) = target.call{value: value}(data);
        if (!ok) revert CallFailed(r);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        if (!ok || r.length < 32) revert TransferFailed();
        return abi.decode(r, (uint256));
    }

    function _sendToken(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (r.length > 0 && !abi.decode(r, (bool)))) revert TransferFailed();
    }

    function _pullToken(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || (r.length > 0 && !abi.decode(r, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory r) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (r.length > 0 && !abi.decode(r, (bool)))) {
            // tokens that require resetting to zero first (USDT-style)
            (ok, r) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
            (ok, r) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
            if (!ok || (r.length > 0 && !abi.decode(r, (bool)))) revert TransferFailed();
        }
    }

    function _sendNative(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
