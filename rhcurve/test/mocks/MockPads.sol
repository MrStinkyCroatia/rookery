// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// minimal ERC20 with an optional transfer tax (bps, burned)
contract MockToken {
    string public name = "Mock"; string public symbol = "MCK"; uint8 public decimals = 18;
    uint256 public totalSupply; uint16 public taxBps;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(uint16 _tax) { taxBps = _tax; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance"); allowance[f][msg.sender] -= a; _move(f, to, a); return true;
    }
    function _move(address f, address to, uint256 a) internal {
        require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a;
        uint256 tax = (a * taxBps) / 10000; balanceOf[to] += a - tax; totalSupply -= tax;
    }
}

interface IRouterLike {
    function buy(address, bytes calldata, address, uint256, address, uint256) external payable returns (uint256);
}

/// a third-party bonding curve: 1 native = `rate` tokens; can refund part of the payment, deliver to a recipient,
/// and in "evil" mode tries to re-enter the router or keep the router's approval
contract MockPad {
    MockToken public token; uint256 public rate = 1000; uint256 public refundBps; bool public evil; address public router;
    constructor(MockToken t) { token = t; }
    function setRefund(uint256 b) external { refundBps = b; }
    function setEvil(bool e, address r) external { evil = e; router = r; }
    function buy(address, uint256 minOut) external payable returns (uint256 out) {
        if (evil) IRouterLike(router).buy{value: 0}(address(this), abi.encodeWithSelector(this.buy.selector, address(token), 0), address(token), 0, msg.sender, type(uint256).max);
        uint256 refund = (msg.value * refundBps) / 10000;
        out = (msg.value - refund) * rate; require(out >= minOut, "pad slippage");
        token.mint(msg.sender, out);
        if (refund > 0) { (bool ok,) = msg.sender.call{value: refund}(""); require(ok, "refund"); }
    }
    function buyFor(address, address to) external payable { token.mint(to, msg.value * rate); }
    function sell(address, uint256 amount, uint256 minOut) external returns (uint256 out) {
        token.transferFrom(msg.sender, address(this), amount);
        out = amount / rate; require(out >= minOut, "pad slippage");
        (bool ok,) = msg.sender.call{value: out}(""); require(ok, "pay");
    }
    function sellHalf(address, uint256 amount) external {          // only takes half of what it was told
        token.transferFrom(msg.sender, address(this), amount / 2);
        (bool ok,) = msg.sender.call{value: amount / 2 / rate}(""); require(ok, "pay");
    }
    receive() external payable {}
}

/// Uniswap-V2-router shaped DEX (graduated tokens), 1 native = `rate` tokens
contract MockV2Router {
    MockToken public token; uint256 public rate = 500;
    constructor(MockToken t) { token = t; }
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minOut, address[] calldata, address to, uint256) external payable {
        uint256 out = msg.value * rate; require(out >= minOut, "v2 slippage"); token.mint(to, out);
    }
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 minOut, address[] calldata, address to, uint256) external {
        token.transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn / rate; require(out >= minOut, "v2 slippage");
        (bool ok,) = to.call{value: out}(""); require(ok, "pay");
    }
    receive() external payable {}
}
