// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RookeryToken} from "./RookeryToken.sol";

interface IERC20R {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address f, address t, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}
interface IWETHR { function deposit() external payable; function withdraw(uint256) external; }
interface IV2FactoryR {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}
interface IV2PairR { function mint(address to) external returns (uint256); }

/// @title RookeryPad — on-chain Rookery launchpad (bonding curve -> Uniswap V2 style DEX).
/// @notice Adapted from StonkPadV2 for Rookery economics. One deployment per chain
///   (Ethereum / Base / BNB Chain / Robinhood Chain), paired with the chain's
///   native coin (ETH or BNB, held as the wrapped token).
///   - constant-product virtual curve: 800M tokens sold, graduates at `target`;
///   - 0.5% fee on every curve buy and sell -> platform burn reserve;
///     20% of that fee goes to the trader's referrer when one is given;
///   - at target: 2% graduation fee, the rest + 200M tokens seed the V2 pair,
///     LP minted to 0xdead (locked forever). The pair address is fixed at
///     launch and the token refuses transfers into it until graduation;
///   - no owner withdraw of curve funds; the owner can only change the fee
///     recipient, the default target for NEW launches, and pause new launches.
contract RookeryPad {
    uint256 public constant SUPPLY        = 1_000_000_000 ether;
    uint256 public constant CURVE_TOKENS  = 800_000_000 ether;
    uint256 public constant LP_TOKENS     = 200_000_000 ether;
    uint16  public constant FEE_BPS       = 50;     // 0.5%
    uint16  public constant REF_SHARE_BPS = 2000;   // 20% of the fee
    uint16  public constant GRAD_FEE_BPS  = 200;    // 2% of the raise
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable weth;
    address public immutable factory;
    bytes32 public immutable pairInitHash;
    address public owner;
    address public treasury;          // burn reserve
    uint256 public defaultTarget;     // in wei of the native coin
    bool    public paused;            // blocks NEW launches only

    struct Sale {
        address token; address creator; address pair; uint64 createdAt; bool graduated;
        uint256 target; uint256 virtualQuote; uint256 virtualTokens; uint256 raised; uint256 sold;
    }
    Sale[] internal sales;
    mapping(address => uint256) public saleOf;   // token => id + 1

    event Created(uint256 indexed id, address indexed token, address indexed creator, string name,
        string symbol, string meta, uint256 target, uint16 creatorBps, uint256 maxWallet);
    event Trade(uint256 indexed id, address indexed trader, bool isBuy, uint256 quoteAmt, uint256 tokenAmt,
        uint256 fee, address referrer, uint256 raised, uint256 sold);
    event Graduated(uint256 indexed id, address indexed token, address pair, uint256 quoteToLp, uint256 gradFee);
    event Config(address treasury, uint256 defaultTarget, bool paused);

    error OnlyOwner();
    modifier onlyOwner() { if (msg.sender != owner) revert OnlyOwner(); _; }
    bool private locked;
    modifier nonReentrant() { require(!locked, "RKP: reentrant"); locked = true; _; locked = false; }

    constructor(address _weth, address _factory, bytes32 _pairInitHash, address _treasury, uint256 _target) {
        require(_weth != address(0) && _factory != address(0) && _treasury != address(0), "RKP: zero");
        weth = _weth; factory = _factory; pairInitHash = _pairInitHash;
        owner = msg.sender; treasury = _treasury; defaultTarget = _target;
        emit Config(_treasury, _target, false);
    }

    // ------------------------------- admin -------------------------------
    function setOwner(address a) external onlyOwner { require(a != address(0), "RKP: zero"); owner = a; }
    function setTreasury(address a) external onlyOwner { require(a != address(0), "RKP: zero"); treasury = a; emit Config(a, defaultTarget, paused); }
    function setDefaultTarget(uint256 t) external onlyOwner { require(t > 0, "RKP: zero"); defaultTarget = t; emit Config(treasury, t, paused); }
    function setPaused(bool p) external onlyOwner { paused = p; emit Config(treasury, defaultTarget, p); }

    // ------------------------------- views -------------------------------
    function salesCount() external view returns (uint256) { return sales.length; }
    function getSale(uint256 id) external view returns (Sale memory) { return sales[id]; }
    function getSales(uint256 from, uint256 n) external view returns (Sale[] memory out) {
        uint256 len = sales.length;
        if (from >= len) return new Sale[](0);
        if (from + n > len) n = len - from;
        out = new Sale[](n);
        for (uint256 i; i < n; i++) out[i] = sales[from + i];
    }
    function quoteBuy(uint256 id, uint256 amountIn) public view returns (uint256 out, uint256 used, uint256 fee) {
        Sale storage s = sales[id];
        if (s.graduated || amountIn == 0) return (0, 0, 0);
        fee = amountIn * FEE_BPS / 10000;
        uint256 net = amountIn - fee;
        uint256 room = s.target - s.raised;
        if (net > room) { net = room; fee = _ceilDiv(net * FEE_BPS, 10000 - FEE_BPS); }
        uint256 qv = s.virtualQuote + s.raised;
        uint256 tv = s.virtualTokens - s.sold;
        out = tv - _ceilDiv(qv * tv, qv + net);
        if (s.sold + out > CURVE_TOKENS) out = CURVE_TOKENS - s.sold;
        used = net + fee;
    }
    function quoteSell(uint256 id, uint256 tokensIn) public view returns (uint256 out, uint256 fee) {
        Sale storage s = sales[id];
        if (s.graduated || tokensIn == 0) return (0, 0);
        uint256 qv = s.virtualQuote + s.raised;
        uint256 tv = s.virtualTokens - s.sold;
        uint256 gross = qv - _ceilDiv(qv * tv, tv + tokensIn);
        if (gross > s.raised) gross = s.raised;
        fee = gross * FEE_BPS / 10000;
        out = gross - fee;
    }

    // ------------------------------- create ------------------------------
    /// @param meta short JSON (image url, description, socials) — stored in the event only
    /// @param customTarget 0 = default; else between 1/4 and 1x the default
    /// @param maxWalletBps 0 = off, else 100-500 (1-5%), auto-off 30 min after graduation
    /// @dev msg.value > 0 = creator's first buy in the same transaction (no sniping the creator)
    function create(
        string calldata name, string calldata symbol, string calldata meta,
        uint16 creatorBps, address creatorWallet, uint256 maxWalletBps, uint256 customTarget, address referrer
    ) external payable nonReentrant returns (uint256 id, address token) {
        require(!paused, "RKP: paused");
        require(bytes(name).length > 0 && bytes(name).length <= 32, "RKP: name");
        require(bytes(symbol).length > 0 && bytes(symbol).length <= 12, "RKP: symbol");
        require(bytes(meta).length <= 1024, "RKP: meta");
        require(maxWalletBps == 0 || (maxWalletBps >= 100 && maxWalletBps <= 500), "RKP: maxWallet 1-5%");
        uint256 target = defaultTarget;
        if (customTarget > 0) {
            require(customTarget >= target / 4 && customTarget <= target, "RKP: target out of range");
            target = customTarget;
        }
        uint256 maxWallet = maxWalletBps == 0 ? 0 : SUPPLY * maxWalletBps / 10000;
        token = address(new RookeryToken(name, symbol, SUPPLY, factory, weth, pairInitHash,
            treasury, creatorBps, creatorWallet, maxWallet));
        address pair = RookeryToken(token).pair();
        id = sales.length;
        sales.push(Sale({
            token: token, creator: msg.sender, pair: pair, createdAt: uint64(block.timestamp), graduated: false,
            // virtual reserves picked so the curve's final price equals the
            // V2 pool's opening price (98% of raise / 200M) — no cliff at graduation
            target: target, virtualQuote: target * 25 / 73, virtualTokens: CURVE_TOKENS * 98 / 73, raised: 0, sold: 0
        }));
        saleOf[token] = id + 1;
        emit Created(id, token, msg.sender, name, symbol, meta, target, creatorBps, maxWallet);
        if (msg.value > 0) {
            IWETHR(weth).deposit{value: msg.value}();
            _buy(id, msg.value, 0, referrer);
        }
    }

    // -------------------------------- trade -------------------------------
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) { return (a + b - 1) / b; }

    function buy(uint256 id, uint256 minOut, address referrer) external payable nonReentrant returns (uint256 out) {
        require(id < sales.length, "RKP: no sale");
        require(msg.value > 0, "RKP: zero");
        IWETHR(weth).deposit{value: msg.value}();
        out = _buy(id, msg.value, minOut, referrer);
    }

    function _buy(uint256 id, uint256 amountIn, uint256 minOut, address referrer) internal returns (uint256 out) {
        Sale storage s = sales[id];
        require(!s.graduated, "RKP: graduated");
        uint256 fee = amountIn * FEE_BPS / 10000;
        uint256 net = amountIn - fee;
        uint256 room = s.target - s.raised;
        if (net > room) {                                   // last buyer: refund the excess
            net = room;
            fee = _ceilDiv(net * FEE_BPS, 10000 - FEE_BPS);
            _pay(msg.sender, amountIn - net - fee);
        }
        {
            uint256 qv = s.virtualQuote + s.raised;
            uint256 tv = s.virtualTokens - s.sold;
            out = tv - _ceilDiv(qv * tv, qv + net);
        }
        if (s.sold + out > CURVE_TOKENS) out = CURVE_TOKENS - s.sold;
        require(out >= minOut, "RKP: slippage");
        require(out > 0, "RKP: curve empty");
        s.raised += net; s.sold += out;
        address ref = _fee(fee, referrer);
        require(IERC20R(s.token).transfer(msg.sender, out), "RKP: send");
        emit Trade(id, msg.sender, true, net, out, fee, ref, s.raised, s.sold);
        if (s.raised >= s.target) _graduate(id);
    }

    function sell(uint256 id, uint256 tokensIn, uint256 minOut, address referrer) external nonReentrant returns (uint256 out) {
        require(id < sales.length, "RKP: no sale");
        Sale storage s = sales[id];
        require(!s.graduated, "RKP: graduated");
        require(tokensIn > 0, "RKP: zero");
        uint256 gross;
        {
            uint256 qv = s.virtualQuote + s.raised;
            uint256 tv = s.virtualTokens - s.sold;
            gross = qv - _ceilDiv(qv * tv, tv + tokensIn);
        }
        require(gross <= s.raised && tokensIn <= s.sold, "RKP: reserve");
        uint256 fee = gross * FEE_BPS / 10000;
        out = gross - fee;
        require(out >= minOut, "RKP: slippage");
        require(IERC20R(s.token).transferFrom(msg.sender, address(this), tokensIn), "RKP: pull");
        s.sold -= tokensIn; s.raised -= gross;
        address ref = _fee(fee, referrer);
        _pay(msg.sender, out);
        emit Trade(id, msg.sender, false, out, tokensIn, fee, ref, s.raised, s.sold);
    }

    function _fee(uint256 fee, address referrer) internal returns (address ref) {
        if (fee == 0) return address(0);
        uint256 toRef;
        if (referrer != address(0) && referrer != msg.sender && referrer != treasury) {
            ref = referrer;
            toRef = fee * REF_SHARE_BPS / 10000;
            _pay(ref, toRef);
        }
        _pay(treasury, fee - toRef);
    }

    // ------------------------------ graduation -----------------------------
    function _graduate(uint256 id) internal {
        Sale storage s = sales[id];
        s.graduated = true;
        uint256 raise = s.raised;
        uint256 gradFee = raise * GRAD_FEE_BPS / 10000;
        uint256 toLp = raise - gradFee;
        address pair = IV2FactoryR(factory).getPair(s.token, weth);
        if (pair == address(0)) pair = IV2FactoryR(factory).createPair(s.token, weth);
        require(pair == s.pair, "RKP: pair mismatch");
        RookeryToken(s.token).openTrading();
        require(IERC20R(s.token).transfer(pair, LP_TOKENS), "RKP: seed token");
        require(IERC20R(weth).transfer(pair, toLp), "RKP: seed quote");
        IV2PairR(pair).mint(DEAD);
        // unsold curve tokens (rounding dust) are burned
        uint256 dust = CURVE_TOKENS - s.sold;
        if (dust > 0) IERC20R(s.token).transfer(DEAD, dust);
        _pay(treasury, gradFee);
        emit Graduated(id, s.token, pair, toLp, gradFee);
    }

    /// @dev pays native coin; falls back to wrapped if the receiver rejects it
    function _pay(address to, uint256 v) internal {
        if (v == 0) return;
        IWETHR(weth).withdraw(v);
        (bool ok, ) = payable(to).call{value: v, gas: 50000}("");
        if (ok) return;
        IWETHR(weth).deposit{value: v}();
        require(IERC20R(weth).transfer(to, v), "RKP: pay");
    }

    receive() external payable { require(msg.sender == weth, "RKP: no direct"); }
}
