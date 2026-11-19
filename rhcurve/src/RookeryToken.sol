// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RookeryToken
/// @notice Fixed-supply ERC-20 launched by the Rookery curve on Robinhood Chain.
///         Before graduation the token can sit in wallets but cannot be sent to contracts (pools),
///         so nobody can open a pool at a different price than the curve. The curve can move
///         tokens it trades without an approval, so a sell is one signature.
contract RookeryToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    address public immutable curve;
    bool public launched;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotCurve();
    error NoContractsBeforeLaunch();
    error Insufficient();

    constructor(string memory _name, string memory _symbol, uint256 _supply, address _curve) {
        name = _name;
        symbol = _symbol;
        curve = _curve;
        totalSupply = _supply;
        balanceOf[_curve] = _supply;
        emit Transfer(address(0), _curve, _supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (msg.sender != curve) {
            uint256 a = allowance[from][msg.sender];
            if (a != type(uint256).max) {
                if (a < value) revert Insufficient();
                allowance[from][msg.sender] = a - value;
            }
        }
        _move(from, to, value);
        return true;
    }

    /// @notice Opens free transfers (graduation).
    function launch() external {
        if (msg.sender != curve) revert NotCurve();
        launched = true;
    }

    /// @notice Burns tokens held by the curve (unused pool reserve at graduation).
    function burn(uint256 value) external {
        if (msg.sender != curve) revert NotCurve();
        uint256 b = balanceOf[curve];
        if (b < value) revert Insufficient();
        balanceOf[curve] = b - value;
        totalSupply -= value;
        emit Transfer(curve, address(0), value);
    }

    /// @dev a wallet upgraded with EIP-7702 (code = 0xef0100 ++ delegate) is still a wallet, not a pool
    function _isContract(address a) internal view returns (bool) {
        uint256 len = a.code.length;
        if (len == 0) return false;
        if (len == 23) {
            bytes memory c = a.code;
            if (c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00) return false;
        }
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        // before launch: no contracts except the curve (wallets are fine)
        if (!launched && to != curve && _isContract(to)) revert NoContractsBeforeLaunch();
        uint256 b = balanceOf[from];
        if (b < value) revert Insufficient();
        unchecked { balanceOf[from] = b - value; }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
