// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RookeryToken} from "./RookeryToken.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function withdraw(uint256) external;
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

interface IUniswapV3Pool {
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min;
        address recipient; uint256 deadline;
    }
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool);
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title RookeryCurve
/// @notice pump-style launchpad on Robinhood Chain. Every token is a real ERC-20 from the first second and lives in
///         the buyer's wallet. Price follows a constant-product curve on virtual reserves. When the curve sells out,
///         anyone can graduate it: the raise and the reserved tokens go into a full-range Uniswap v3 pool and the LP
///         position is sent to the dead address, so the liquidity is locked forever.
///         The owner can only change settings for FUTURE launches and the fee address; it can never touch a curve's ETH.
contract RookeryCurve {
    // ---- constants ----
    uint256 public constant SUPPLY = 1_000_000_000 ether;
    uint256 public constant CURVE_TOKENS = 800_000_000 ether;       // sold on the curve
    uint256 public constant V_TOKEN = 1_073_000_000 ether;          // virtual token reserve
    uint24 public constant POOL_FEE = 10000;                        // 1% Uniswap v3 tier
    int24 public constant TICK_LOWER = -887200;                     // full range for spacing 200
    int24 public constant TICK_UPPER = 887200;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant MIN_SQRT = 4295128740;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    // ---- external ----
    IWETH9 public immutable weth;
    IUniswapV3Factory public immutable factory;
    INonfungiblePositionManager public immutable npm;

    // ---- settings ----
    address public owner;
    address public feeTo;
    uint16 public feeBps = 50;            // 0.5% of every curve trade
    uint256 public vEthNext;              // virtual ETH for new launches (sets the starting market cap)
    bool public launchesPaused;

    struct Curve {
        address creator;
        uint128 vEth;        // virtual ETH reserve fixed at launch
        uint128 realEth;     // ETH the curve actually holds
        uint128 sold;        // tokens sold out of CURVE_TOKENS
        uint64 createdAt;
        bool complete;
        bool graduated;
        address pool;
    }
    mapping(address => Curve) public curves;
    address[] public allTokens;
    uint256 public feesAccrued;

    uint256 private locked = 1;
    address private gradPool;             // the only pool allowed to call the swap callback (set inside graduate)

    event Created(address indexed token, address indexed creator, string name, string symbol, uint256 vEth);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount,
        uint256 fee, uint256 realEth, uint256 sold);
    event Complete(address indexed token);
    event Graduated(address indexed token, address pool, uint256 lpTokenId, uint256 ethToPool, uint256 tokensToPool, uint256 tokensBurned);
    event FeesClaimed(address to, uint256 amount);

    error Paused();
    error UnknownToken();
    error CurveClosed();
    error NotComplete();
    error Slippage();
    error Zero();
    error NotOwner();
    error EthTransfer();

    modifier nonReentrant() {
        require(locked == 1, "reentrancy");
        locked = 2;
        _;
        locked = 1;
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _weth, address _factory, address _npm, address _feeTo, uint256 _vEth) {
        weth = IWETH9(_weth);
        factory = IUniswapV3Factory(_factory);
        npm = INonfungiblePositionManager(_npm);
        owner = msg.sender;
        feeTo = _feeTo;
        vEthNext = _vEth;
    }

    // ---------------------------------------------------------------- launch
    function create(string calldata name, string calldata symbol, uint256 minTokensOut) external payable nonReentrant returns (address token) {
        if (launchesPaused) revert Paused();
        if (bytes(name).length == 0 || bytes(symbol).length == 0 || bytes(name).length > 32 || bytes(symbol).length > 12) revert Zero();
        token = address(new RookeryToken(name, symbol, SUPPLY, address(this)));
        curves[token] = Curve({ creator: msg.sender, vEth: uint128(vEthNext), realEth: 0, sold: 0, createdAt: uint64(block.timestamp),
            complete: false, graduated: false, pool: address(0) });
        allTokens.push(token);
        emit Created(token, msg.sender, name, symbol, vEthNext);
        if (msg.value > 0) _buy(token, msg.sender, msg.value, minTokensOut);
    }

    // ---------------------------------------------------------------- trading
    function buy(address token, uint256 minTokensOut) external payable nonReentrant returns (uint256 out) {
        out = _buy(token, msg.sender, msg.value, minTokensOut);
    }

    function sell(address token, uint256 tokenAmount, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.complete) revert CurveClosed();
        if (tokenAmount == 0) revert Zero();
        uint256 x = uint256(c.vEth) + c.realEth;
        uint256 y = V_TOKEN - c.sold;
        uint256 k = uint256(c.vEth) * V_TOKEN;
        uint256 gross = x - _divUp(k, y + tokenAmount);
        if (gross > c.realEth) gross = c.realEth;
        uint256 fee = (gross * feeBps) / 10000;
        ethOut = gross - fee;
        if (ethOut < minEthOut) revert Slippage();
        // effects
        c.realEth -= uint128(gross);
        c.sold -= uint128(tokenAmount);
        feesAccrued += fee;
        // interactions: the curve pulls the tokens back without an approval
        RookeryToken(token).transferFrom(msg.sender, address(this), tokenAmount);
        _sendEth(msg.sender, ethOut);
        emit Trade(token, msg.sender, false, gross, tokenAmount, fee, c.realEth, c.sold);
    }

    function _buy(address token, address buyer, uint256 ethIn, uint256 minTokensOut) internal returns (uint256 out) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.complete) revert CurveClosed();
        if (ethIn == 0) revert Zero();
        uint256 fee = (ethIn * feeBps) / 10000;
        uint256 net = ethIn - fee;
        uint256 x = uint256(c.vEth) + c.realEth;
        uint256 y = V_TOKEN - c.sold;
        uint256 k = uint256(c.vEth) * V_TOKEN;
        out = y - _divUp(k, x + net);
        uint256 left = CURVE_TOKENS - c.sold;
        uint256 refund;
        if (out >= left) {
            // the buy that empties the curve takes only what the remaining tokens cost
            out = left;
            uint256 need = _divUp(k, y - left) - x;
            uint256 feeNeed = (need * feeBps) / (10000 - feeBps);
            if (need + feeNeed < ethIn) { refund = ethIn - need - feeNeed; net = need; fee = feeNeed; }
        }
        if (out < minTokensOut) revert Slippage();
        c.realEth += uint128(net);
        c.sold += uint128(out);
        feesAccrued += fee;
        if (c.sold == CURVE_TOKENS) { c.complete = true; emit Complete(token); }
        RookeryToken(token).transfer(buyer, out);
        if (refund > 0) _sendEth(buyer, refund);
        emit Trade(token, buyer, true, net, out, fee, c.realEth, c.sold);
    }

    // ---------------------------------------------------------------- graduation
    /// @notice Anyone can graduate a sold-out curve into a full-range Uniswap v3 pool. The LP NFT goes to the dead address.
    function graduate(address token) external nonReentrant returns (address pool) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (!c.complete || c.graduated) revert NotComplete();
        c.graduated = true;

        uint256 ethForPool = c.realEth;
        uint256 reserve = SUPPLY - CURVE_TOKENS;                      // 200M kept for the pool
        // the pool opens at the curve's last price: P = (vEth + realEth) / (V_TOKEN - sold) ETH per token
        uint256 px = uint256(c.vEth) + c.realEth;
        uint256 pt = V_TOKEN - c.sold;
        uint256 tokForPool = (ethForPool * pt) / px;                   // tokens matching the raise at that price
        uint256 extraEth;
        if (tokForPool > reserve) { tokForPool = reserve; uint256 needEth = (reserve * px) / pt; extraEth = ethForPool - needEth; ethForPool = needEth; }
        uint256 burnTok = reserve - tokForPool;
        c.realEth = 0;

        RookeryToken t = RookeryToken(token);
        t.launch();                                                   // pools may hold it from now on
        if (burnTok > 0) t.burn(burnTok);

        (address t0, address t1) = token < address(weth) ? (token, address(weth)) : (address(weth), token);
        (uint256 a0, uint256 a1) = token < address(weth) ? (tokForPool, ethForPool) : (ethForPool, tokForPool);
        uint160 sqrtP = _sqrtPriceX96(a0, a1);

        pool = npm.createAndInitializePoolIfNecessary(t0, t1, POOL_FEE, sqrtP);
        // someone may have created the pool early at another price; it holds no liquidity (the token could not be
        // sent to contracts before launch), so a zero-size swap moves its price to ours for free
        (uint160 cur,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (cur != sqrtP && IUniswapV3Pool(pool).liquidity() == 0) {
            gradPool = pool;
            IUniswapV3Pool(pool).swap(address(this), cur > sqrtP, 1, sqrtP, "");
            gradPool = address(0);
        }

        weth.deposit{value: ethForPool}();
        weth.approve(address(npm), ethForPool);
        t.approve(address(npm), tokForPool);
        (uint256 tokenId,, uint256 used0, uint256 used1) = npm.mint(INonfungiblePositionManager.MintParams({
            token0: t0, token1: t1, fee: POOL_FEE, tickLower: TICK_LOWER, tickUpper: TICK_UPPER,
            amount0Desired: a0, amount1Desired: a1, amount0Min: 0, amount1Min: 0, recipient: address(this), deadline: block.timestamp }));
        npm.transferFrom(address(this), DEAD, tokenId);               // liquidity locked forever

        // whatever the position did not take: tokens are burned, ETH goes to the fee address (buy & burn)
        uint256 usedTok = token < address(weth) ? used0 : used1;
        uint256 usedEth = token < address(weth) ? used1 : used0;
        uint256 tokLeft = tokForPool - usedTok;
        if (tokLeft > 0) t.burn(tokLeft);
        uint256 wethLeft = ethForPool - usedEth;
        if (wethLeft > 0) { weth.withdraw(wethLeft); extraEth += wethLeft; }
        if (extraEth > 0) feesAccrued += extraEth;

        c.pool = pool;
        emit Graduated(token, pool, tokenId, usedEth, usedTok, burnTok + tokLeft);
    }

    /// @dev zero-size price fix on an empty pool: owes at most 1 wei
    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external {
        // only the pool being graduated, only inside graduate()
        require(msg.sender == gradPool && gradPool != address(0), "no");
        if (amount0 > 0) _payPool(msg.sender, amount0, true);
        if (amount1 > 0) _payPool(msg.sender, amount1, false);
    }
    function _payPool(address pool, int256 amt, bool isToken0) internal {
        // the pool's tokens: pay with WETH if WETH is that side, otherwise with the launched token we hold
        (bool ok, bytes memory d) = pool.staticcall(abi.encodeWithSignature(isToken0 ? "token0()" : "token1()"));
        require(ok, "pool");
        address tk = abi.decode(d, (address));
        if (tk == address(weth)) { weth.deposit{value: uint256(amt)}(); RookeryToken(address(weth)).transfer(pool, uint256(amt)); }
        else { require(curves[tk].creator != address(0), "pool"); RookeryToken(tk).transfer(pool, uint256(amt)); }
    }

    // ---------------------------------------------------------------- views
    function quoteBuy(address token, uint256 ethIn) external view returns (uint256 out) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.complete || ethIn == 0) return 0;
        uint256 net = ethIn - (ethIn * feeBps) / 10000;
        uint256 x = uint256(c.vEth) + c.realEth;
        uint256 y = V_TOKEN - c.sold;
        out = y - _divUp(uint256(c.vEth) * V_TOKEN, x + net);
        uint256 left = CURVE_TOKENS - c.sold;
        if (out > left) out = left;
    }
    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 ethOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.complete || tokenAmount == 0) return 0;
        uint256 x = uint256(c.vEth) + c.realEth;
        uint256 y = V_TOKEN - c.sold;
        uint256 gross = x - _divUp(uint256(c.vEth) * V_TOKEN, y + tokenAmount);
        if (gross > c.realEth) gross = c.realEth;
        ethOut = gross - (gross * feeBps) / 10000;
    }
    /// @notice price in wei per whole token (1e18 units)
    function price(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) return 0;
        return ((uint256(c.vEth) + c.realEth) * 1 ether) / (V_TOKEN - c.sold);
    }
    function tokensCount() external view returns (uint256) { return allTokens.length; }

    // ---------------------------------------------------------------- admin (future launches + fees only)
    function claimFees() external {
        uint256 a = feesAccrued;
        feesAccrued = 0;
        _sendEth(feeTo, a);
        emit FeesClaimed(feeTo, a);
    }
    function setFeeTo(address a) external onlyOwner { feeTo = a; }
    function setVEthNext(uint256 v) external onlyOwner { require(v >= 0.1 ether && v <= 100 ether, "range"); vEthNext = v; }
    function setFeeBps(uint16 b) external onlyOwner { require(b <= 100, "max 1%"); feeBps = b; }
    function setLaunchesPaused(bool p) external onlyOwner { launchesPaused = p; }
    function transferOwnership(address o) external onlyOwner { owner = o; }

    // ---------------------------------------------------------------- internals
    function _sendEth(address to, uint256 a) internal {
        if (a == 0) return;
        (bool ok,) = to.call{value: a}("");
        if (!ok) revert EthTransfer();
    }
    function _divUp(uint256 a, uint256 b) internal pure returns (uint256) { return (a + b - 1) / b; }
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        // sqrt(amount1 / amount0) * 2^96, computed as sqrt((amount1 << 96) / amount0 << 96)
        uint256 r = (amount1 << 96) / amount0;
        uint256 s = _sqrt(r << 96);
        if (s < MIN_SQRT) s = MIN_SQRT;
        if (s > MAX_SQRT) s = MAX_SQRT;
        return uint160(s);
    }
    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x; uint256 y = (x >> 1) + 1;
        while (y < z) { z = y; y = (x / y + y) >> 1; }
    }

    receive() external payable {
        require(msg.sender == address(weth), "no direct ETH");
    }
}
