// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
/// test stand-in for a Robinhood Stock Token (plain 18-decimal ERC-20)
contract MockStock {
    string public name = "Tesla Robinhood Token"; string public symbol = "TSLA"; uint8 public decimals = 18; uint256 public totalSupply;
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; emit Transfer(address(0), to, a); }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { _t(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender]; if (al != type(uint256).max) { require(al >= a, "allowance"); allowance[f][msg.sender] = al - a; }
        _t(f, to, a); return true;
    }
    function _t(address f, address to, uint256 a) internal { require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; balanceOf[to] += a; emit Transfer(f, to, a); }
}
