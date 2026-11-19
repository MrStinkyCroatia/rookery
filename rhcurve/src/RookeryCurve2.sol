// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RookeryToken2} from "./RookeryToken2.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}
interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}
interface ISwapRouter02 {
    struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}
interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}
interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
}

/// @notice deploys RookeryToken2 for the curve (kept apart so the curve stays under the contract size limit)
contract RookeryTokenDeployer {
    address public immutable curve;
    constructor() { curve = msg.sender; }
    function deploy(string calldata name, string calldata symbol, uint256 supply, address creator, uint16 mkt, uint16 brn, uint16 rew)
        external returns (address)
    {
        require(msg.sender == curve, "curve");
        return address(new RookeryToken2(name, symbol, supply, curve, creator, mkt, brn, rew));
    }
}

/// @title RookeryCurve2
/// @notice pump-style launchpad on Robinhood Chain. Every token is a real ERC-20 from the first second and lives in the
///         buyer's wallet. A token trades against its pair asset (ETH, USDG or a Robinhood Stock Token from the allow
///         list) on a constant-product curve with virtual reserves. Creator taxes (marketing / burn / rewards) apply on
///         the curve and, after graduation, on the Uniswap V2 pool through the token itself. When the curve sells out,
///         anyone can graduate it: the raise and the reserved tokens go into a Uniswap V2 pool and the LP tokens are
///         minted straight to the dead address, so the liquidity is locked forever.
///         The owner only manages the pair allow-list and settings for FUTURE launches; it can never touch a curve's funds.
contract RookeryCurve2 {
    uint256 public constant SUPPLY = 1_000_000_000 ether;
    uint256 public constant CURVE_TOKENS = 800_000_000 ether;
    uint256 public constant V_TOKEN = 1_073_000_000 ether;
    uint16 public constant MAX_TAX = 500;          // 5% each
    uint16 public constant MAX_TAX_TOTAL = 1000;   // 10% together
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address public constant ETH = address(0);

    IWETH9 public immutable weth;
    IUniswapV2Factory public immutable factoryV2;
    ISwapRouter02 public immutable router;          // Uniswap SwapRouter02: ETH <-> pair asset for stock pairs
    RookeryTokenDeployer public immutable deployer;

    address public owner;
    address public feeTo;
    uint16 public feeBps = 50;                     // platform 0.5% of every curve trade ($臭企鹅 buy & burn)
    bool public launchesPaused;
    /// @notice allowed pair assets and the virtual reserve a new launch gets in that asset (sets the starting mcap)
    mapping(address => uint256) public vQuoteFor;

    struct Curve {
        address creator;
        address quote;       // ETH (0) or an ERC-20
        uint128 vQuote;
        uint128 realQuote;
        uint128 sold;
        uint64 createdAt;
        bool complete;
        bool graduated;
        address pair;
    }
    mapping(address => Curve) public curves;
    address[] public allTokens;
    mapping(address => uint256) public feesAccrued;                       // per pair asset
    mapping(address => mapping(address => uint256)) public creatorOwed;   // creator => asset => marketing owed

    uint256 private locked = 1;

    event Created(address indexed token, address indexed creator, address indexed quote, string name, string symbol,
        uint256 vQuote, uint16 taxMarketing, uint16 taxBurn, uint16 taxRewards);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount,
        uint256 fee, uint256 realQuote, uint256 sold);
    event Taxes(address indexed token, uint256 marketingQuote, uint256 burnedTokens, uint256 rewardTokens);
    event Complete(address indexed token);
    event Graduated(address indexed token, address pair, uint256 liquidity, uint256 quoteToPool, uint256 tokensToPool, uint256 tokensBurned);
    event QuoteSet(address indexed quote, uint256 vQuote);

    error Paused(); error UnknownToken(); error CurveClosed(); error NotComplete(); error Slippage();
    error Zero(); error NotOwner(); error EthTransfer(); error BadQuote(); error BadTax();

    modifier nonReentrant() { require(locked == 1, "reentrancy"); locked = 2; _; locked = 1; }
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address _weth, address _factoryV2, address _router, address _feeTo, uint256 _vEth) {
        weth = IWETH9(_weth);
        factoryV2 = IUniswapV2Factory(_factoryV2);
        router = ISwapRouter02(_router);
        deployer = new RookeryTokenDeployer();
        owner = msg.sender;
        feeTo = _feeTo;
        vQuoteFor[ETH] = _vEth;
        emit QuoteSet(ETH, _vEth);
    }

    // ---------------------------------------------------------------- launch
    function create(string calldata name, string calldata symbol, address quote, uint16 taxMkt, uint16 taxBurn, uint16 taxRew,
        uint256 quoteIn, uint256 minTokensOut) external payable nonReentrant returns (address token)
    {
        if (quote != ETH && msg.value > 0) revert BadQuote();
        token = _create(name, symbol, quote, taxMkt, taxBurn, taxRew);
        uint256 amt = quote == ETH ? msg.value : quoteIn;
        if (amt > 0) _buy(token, msg.sender, _pullQuote(quote, amt), minTokensOut);
    }

    /// @notice launch a token paired with a stock token (or USDG) and make the first buy with plain ETH:
    ///         the ETH is swapped on Uniswap v3 along `path` (WETH -> ... -> pair asset) inside this transaction
    function createWithEth(string calldata name, string calldata symbol, address quote, uint16 taxMkt, uint16 taxBurn, uint16 taxRew,
        bytes calldata path, uint256 minQuote, uint256 minTokensOut) external payable nonReentrant returns (address token)
    {
        if (quote == ETH || msg.value == 0) revert BadQuote();
        token = _create(name, symbol, quote, taxMkt, taxBurn, taxRew);
        _buy(token, msg.sender, _swapEthTo(quote, path, minQuote), minTokensOut);
    }

    function _create(string calldata name, string calldata symbol, address quote, uint16 taxMkt, uint16 taxBurn, uint16 taxRew)
        internal returns (address token)
    {
        if (launchesPaused) revert Paused();
        if (bytes(name).length == 0 || bytes(symbol).length == 0 || bytes(name).length > 32 || bytes(symbol).length > 12) revert Zero();
        uint256 vq = vQuoteFor[quote];
        if (vq == 0) revert BadQuote();
        if (taxMkt > MAX_TAX || taxBurn > MAX_TAX || taxRew > MAX_TAX || uint256(taxMkt) + taxBurn + taxRew > MAX_TAX_TOTAL) revert BadTax();
        token = deployer.deploy(name, symbol, SUPPLY, msg.sender, taxMkt, taxBurn, taxRew);
        curves[token] = Curve({ creator: msg.sender, quote: quote, vQuote: uint128(vq), realQuote: 0, sold: 0,
            createdAt: uint64(block.timestamp), complete: false, graduated: false, pair: address(0) });
        allTokens.push(token);
        emit Created(token, msg.sender, quote, name, symbol, vq, taxMkt, taxBurn, taxRew);
    }

    // ---------------------------------------------------------------- trading
    function buy(address token, uint256 quoteIn, uint256 minTokensOut) external payable nonReentrant returns (uint256 out) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.quote != ETH && msg.value > 0) revert BadQuote();
        out = _buy(token, msg.sender, _pullQuote(c.quote, c.quote == ETH ? msg.value : quoteIn), minTokensOut);
    }

    /// @notice buy a stock-paired (or USDG-paired) token with plain ETH in one transaction
    function buyWithEth(address token, bytes calldata path, uint256 minQuote, uint256 minTokensOut) external payable nonReentrant returns (uint256 out) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.quote == ETH || msg.value == 0) revert BadQuote();
        out = _buy(token, msg.sender, _swapEthTo(c.quote, path, minQuote), minTokensOut);
    }

    function sell(address token, uint256 tokenAmount, uint256 minQuoteOut) external nonReentrant returns (uint256 quoteOut) {
        quoteOut = _sell(token, tokenAmount, minQuoteOut, msg.sender);
    }

    /// @notice sell a stock-paired token and receive plain ETH: the pair asset is swapped back along `path`
    ///         (pair asset -> ... -> WETH) and unwrapped in the same transaction
    function sellForEth(address token, uint256 tokenAmount, bytes calldata path, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.quote == ETH) revert BadQuote();
        uint256 q = _sell(token, tokenAmount, 0, address(this));
        (address a, address z) = _pathEnds(path);
        require(a == c.quote && z == address(weth), "path");
        _safeApprove(c.quote, address(router), q);
        uint256 w0 = weth.balanceOf(address(this));
        router.exactInput(ISwapRouter02.ExactInputParams({ path: path, recipient: address(this), amountIn: q, amountOutMinimum: minEthOut }));
        _safeApprove(c.quote, address(router), 0);
        ethOut = weth.balanceOf(address(this)) - w0;
        if (ethOut < minEthOut) revert Slippage();
        weth.withdraw(ethOut);
        _sendQuote(ETH, msg.sender, ethOut);
    }

    function _sell(address token, uint256 tokenAmount, uint256 minQuoteOut, address payTo) internal returns (uint256 quoteOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.complete) revert CurveClosed();
        if (tokenAmount == 0) revert Zero();
        RookeryToken2 t = RookeryToken2(token);
        // token taxes: burn + rewards come out of the tokens sold
        uint256 brn = (tokenAmount * t.taxBurn()) / 10000;
        uint256 rew = (tokenAmount * t.taxRewards()) / 10000;
        uint256 net = tokenAmount - brn - rew;
        uint256 x = uint256(c.vQuote) + c.realQuote;
        uint256 y = V_TOKEN - c.sold;
        uint256 gross = x - _divUp(uint256(c.vQuote) * V_TOKEN, y + net);
        if (gross > c.realQuote) gross = c.realQuote;
        uint256 fee = (gross * feeBps) / 10000;
        uint256 mkt = (gross * t.taxMarketing()) / 10000;
        quoteOut = gross - fee - mkt;
        if (quoteOut < minQuoteOut) revert Slippage();
        c.realQuote -= uint128(gross);
        c.sold -= uint128(net);
        feesAccrued[c.quote] += fee;
        creatorOwed[t.creator()][c.quote] += mkt;
        t.transferFrom(msg.sender, address(this), tokenAmount);    // the curve pulls without an approval
        if (brn > 0) t.burn(brn);
        if (rew > 0) { t.transfer(token, rew); t.distribute(rew); }
        if (payTo != address(this)) _sendQuote(c.quote, payTo, quoteOut);
        emit Taxes(token, mkt, brn, rew);
        emit Trade(token, msg.sender, false, gross, tokenAmount, fee, c.realQuote, c.sold);
    }

    function _buy(address token, address buyer, uint256 quoteIn, uint256 minTokensOut) internal returns (uint256 out) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.complete) revert CurveClosed();
        if (quoteIn == 0) revert Zero();
        RookeryToken2 t = RookeryToken2(token);
        uint256 cut = uint256(feeBps) + t.taxMarketing();               // bps taken from the quote paid in
        uint256 net = quoteIn - (quoteIn * cut) / 10000;
        uint256 x = uint256(c.vQuote) + c.realQuote;
        uint256 y = V_TOKEN - c.sold;
        uint256 k = uint256(c.vQuote) * V_TOKEN;
        uint256 gross = y - _divUp(k, x + net);
        uint256 left = CURVE_TOKENS - c.sold;
        uint256 refund;
        if (gross >= left) {
            gross = left;
            uint256 need = _divUp(k, y - left) - x;
            uint256 pay = (need * 10000) / (10000 - cut) + 1;
            if (pay < quoteIn) { refund = quoteIn - pay; quoteIn = pay; net = need; }
        }
        uint256 fee = (quoteIn * feeBps) / 10000;
        uint256 mkt = quoteIn - net - fee;
        uint256 brn = (gross * t.taxBurn()) / 10000;
        uint256 rew = (gross * t.taxRewards()) / 10000;
        out = gross - brn - rew;
        if (out < minTokensOut) revert Slippage();
        c.realQuote += uint128(net);
        c.sold += uint128(gross);
        feesAccrued[c.quote] += fee;
        creatorOwed[t.creator()][c.quote] += mkt;
        if (c.sold == CURVE_TOKENS) { c.complete = true; emit Complete(token); }
        // rewards go to the holders BEFORE this buyer receives tokens: nobody earns from their own buy
        if (brn > 0) t.burn(brn);
        if (rew > 0) { t.transfer(token, rew); t.distribute(rew); }
        t.transfer(buyer, out);
        if (refund > 0) _sendQuote(c.quote, buyer, refund);
        emit Taxes(token, mkt, brn, rew);
        emit Trade(token, buyer, true, net, gross, fee, c.realQuote, c.sold);
    }

    // ---------------------------------------------------------------- graduation (Uniswap V2, LP to the dead address)
    function graduate(address token) external nonReentrant returns (address pair) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (!c.complete || c.graduated) revert NotComplete();
        c.graduated = true;

        uint256 qForPool = c.realQuote;
        uint256 reserve = SUPPLY - CURVE_TOKENS;
        uint256 px = uint256(c.vQuote) + c.realQuote;      // last curve price = px / pt quote per token
        uint256 pt = V_TOKEN - c.sold;
        uint256 tokForPool = (qForPool * pt) / px;
        uint256 extra;
        if (tokForPool > reserve) { tokForPool = reserve; uint256 needQ = (reserve * px) / pt; extra = qForPool - needQ; qForPool = needQ; }
        c.realQuote = 0;

        RookeryToken2 t = RookeryToken2(token);
        address qt = c.quote == ETH ? address(weth) : c.quote;
        pair = factoryV2.getPair(token, qt);
        if (pair == address(0)) pair = factoryV2.createPair(token, qt);
        t.launch(pair);                                    // pools may hold it from now on; taxes switch on for the pair
        uint256 burnTok = t.balanceOf(address(this)) - tokForPool;
        if (burnTok > 0) t.burn(burnTok);

        t.transfer(pair, tokForPool);                      // from the curve: never taxed
        if (c.quote == ETH) { weth.deposit{value: qForPool}(); weth.transfer(pair, qForPool); }
        else _safeTransfer(c.quote, pair, qForPool);
        uint256 liq = IUniswapV2Pair(pair).mint(DEAD);     // LP straight to the dead address: locked forever
        if (extra > 0) feesAccrued[c.quote] += extra;      // rounding leftovers join the $臭企鹅 buy & burn

        c.pair = pair;
        emit Graduated(token, pair, liq, qForPool, tokForPool, burnTok);
    }

    // ---------------------------------------------------------------- claims
    function claimFees(address quote) external {
        uint256 a = feesAccrued[quote];
        feesAccrued[quote] = 0;
        _sendQuote(quote, feeTo, a);
    }
    /// @notice the creator's marketing tax from curve trades, in the pair asset
    function claimCreator(address quote) external nonReentrant {
        uint256 a = creatorOwed[msg.sender][quote];
        creatorOwed[msg.sender][quote] = 0;
        _sendQuote(quote, msg.sender, a);
    }

    // ---------------------------------------------------------------- views
    function quoteBuy(address token, uint256 quoteIn) external view returns (uint256 out) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.complete || quoteIn == 0) return 0;
        RookeryToken2 t = RookeryToken2(token);
        uint256 net = quoteIn - (quoteIn * (uint256(feeBps) + t.taxMarketing())) / 10000;
        uint256 x = uint256(c.vQuote) + c.realQuote;
        uint256 y = V_TOKEN - c.sold;
        uint256 gross = y - _divUp(uint256(c.vQuote) * V_TOKEN, x + net);
        uint256 left = CURVE_TOKENS - c.sold;
        if (gross > left) gross = left;
        out = gross - (gross * t.taxBurn()) / 10000 - (gross * t.taxRewards()) / 10000;
    }
    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 quoteOut) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.complete || tokenAmount == 0) return 0;
        RookeryToken2 t = RookeryToken2(token);
        uint256 net = tokenAmount - (tokenAmount * t.taxBurn()) / 10000 - (tokenAmount * t.taxRewards()) / 10000;
        uint256 x = uint256(c.vQuote) + c.realQuote;
        uint256 y = V_TOKEN - c.sold;
        uint256 gross = x - _divUp(uint256(c.vQuote) * V_TOKEN, y + net);
        if (gross > c.realQuote) gross = c.realQuote;
        quoteOut = gross - (gross * feeBps) / 10000 - (gross * t.taxMarketing()) / 10000;   // same rounding as sell()
    }
    function tokensCount() external view returns (uint256) { return allTokens.length; }

    // ---------------------------------------------------------------- admin (pair allow-list + future launches only)
    function setQuotes(address[] calldata quotes, uint256[] calldata vQuotes) external onlyOwner {
        require(quotes.length == vQuotes.length, "len");
        for (uint256 i; i < quotes.length; i++) { vQuoteFor[quotes[i]] = vQuotes[i]; emit QuoteSet(quotes[i], vQuotes[i]); }
    }
    function setFeeTo(address a) external onlyOwner { feeTo = a; }
    function setFeeBps(uint16 b) external onlyOwner { require(b <= 100, "max 1%"); feeBps = b; }
    function setLaunchesPaused(bool p) external onlyOwner { launchesPaused = p; }
    function transferOwnership(address o) external onlyOwner { owner = o; }

    // ---------------------------------------------------------------- internals
    /// @dev takes the pair asset in and returns what actually arrived (safe for tokens with transfer fees)
    function _pullQuote(address quote, uint256 amt) internal returns (uint256) {
        if (quote == ETH) return amt;
        uint256 b0 = IERC20(quote).balanceOf(address(this));
        _safeTransferFrom(quote, msg.sender, address(this), amt);
        return IERC20(quote).balanceOf(address(this)) - b0;
    }
    function _sendQuote(address quote, address to, uint256 a) internal {
        if (a == 0) return;
        if (quote == ETH) { (bool ok,) = to.call{value: a}(""); if (!ok) revert EthTransfer(); }
        else _safeTransfer(quote, to, a);
    }
    function _safeTransfer(address tk, address to, uint256 a) internal {
        (bool ok, bytes memory d) = tk.call(abi.encodeWithSelector(IERC20.transfer.selector, to, a));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "transfer");
    }
    function _safeTransferFrom(address tk, address from, address to, uint256 a) internal {
        (bool ok, bytes memory d) = tk.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, a));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "transferFrom");
    }
    function _divUp(uint256 a, uint256 b) internal pure returns (uint256) { return (a + b - 1) / b; }

    /// @dev Uniswap v3 path = token(20) [fee(3) token(20)]...
    function _pathEnds(bytes calldata path) internal pure returns (address first, address last) {
        require(path.length >= 43 && (path.length - 20) % 23 == 0, "path");
        first = address(bytes20(path[0:20]));
        last = address(bytes20(path[path.length - 20:]));
    }
    /// @dev ETH -> pair asset through the fixed Uniswap router; returns what actually arrived here
    function _swapEthTo(address quote, bytes calldata path, uint256 minQuote) internal returns (uint256 got) {
        (address a, address z) = _pathEnds(path);
        require(a == address(weth) && z == quote, "path");
        uint256 b0 = IERC20(quote).balanceOf(address(this));
        router.exactInput{value: msg.value}(ISwapRouter02.ExactInputParams({ path: path, recipient: address(this), amountIn: msg.value, amountOutMinimum: minQuote }));
        got = IERC20(quote).balanceOf(address(this)) - b0;
        if (got < minQuote) revert Slippage();
    }
    function _safeApprove(address tk, address spender, uint256 a) internal {
        (bool ok, bytes memory d) = tk.call(abi.encodeWithSignature("approve(address,uint256)", spender, a));
        require(ok && (d.length == 0 || abi.decode(d, (bool))), "approve");
    }

    receive() external payable { require(msg.sender == address(weth), "use buy()"); }
}
