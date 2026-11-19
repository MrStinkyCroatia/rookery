// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title RookeryToken2
/// @notice Fixed-supply ERC-20 launched by RookeryCurve2 on Robinhood Chain, with the creator's taxes:
///         marketing (to the creator), burn and holder rewards. On the bonding curve the curve applies them;
///         after graduation the token applies them itself on every buy and sell through its Uniswap V2 pair.
///         Wallet-to-wallet transfers are never taxed. Rewards are paid in this token: they accrue per token
///         held and land in the holder's balance on their next transfer, or any time with claim().
///         Before graduation the token can sit in wallets but not in contracts, so no pool can open early.
contract RookeryToken2 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    address public immutable curve;
    address public immutable creator;          // receives the marketing tax
    uint16 public immutable taxMarketing;      // bps
    uint16 public immutable taxBurn;
    uint16 public immutable taxRewards;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public pair;
    bool public launched;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // rewards: accumulated reward per token held (1e36 fixed point) and each holder's checkpoint
    uint256 public accRewardPerToken;
    mapping(address => uint256) internal rewardDebt;
    uint256 public rewardsDistributed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Taxed(address indexed from, address indexed to, uint256 marketing, uint256 burned, uint256 rewards);
    event RewardsAdded(uint256 amount, uint256 accRewardPerToken);

    error NotCurve();
    error NoContractsBeforeLaunch();
    error Insufficient();

    constructor(string memory _name, string memory _symbol, uint256 _supply, address _curve, address _creator,
        uint16 _mkt, uint16 _burn, uint16 _rew) {
        name = _name;
        symbol = _symbol;
        curve = _curve;
        creator = _creator;
        taxMarketing = _mkt;
        taxBurn = _burn;
        taxRewards = _rew;
        totalSupply = _supply;
        balanceOf[_curve] = _supply;
        emit Transfer(address(0), _curve, _supply);
    }

    // ---------------------------------------------------------------- ERC-20
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
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
        _transfer(from, to, value);
        return true;
    }

    // ---------------------------------------------------------------- rewards
    function _excluded(address a) internal view returns (bool) {
        return a == curve || a == pair || a == DEAD || a == address(this) || a == address(0);
    }
    /// @notice tokens that earn rewards: everything outside the curve, the pool, the dead address and the reward pot
    function eligibleSupply() public view returns (uint256) {
        uint256 ex = balanceOf[curve] + balanceOf[DEAD] + balanceOf[address(this)];
        if (pair != address(0)) ex += balanceOf[pair];
        return totalSupply > ex ? totalSupply - ex : 0;
    }
    function pendingRewards(address a) public view returns (uint256) {
        if (_excluded(a)) return 0;
        uint256 owed = (balanceOf[a] * accRewardPerToken) / 1e36;
        return owed > rewardDebt[a] ? owed - rewardDebt[a] : 0;
    }
    function _settle(address a) internal {
        if (_excluded(a)) return;
        uint256 p = pendingRewards(a);
        if (p > 0) {
            uint256 pot = balanceOf[address(this)];
            if (p > pot) p = pot;
            balanceOf[address(this)] = pot - p;
            balanceOf[a] += p;
            emit Transfer(address(this), a, p);
        }
    }
    function _checkpoint(address a) internal {
        if (!_excluded(a)) rewardDebt[a] = (balanceOf[a] * accRewardPerToken) / 1e36;
    }
    /// @dev tokens already sitting in this contract become rewards for current holders
    function _addRewards(uint256 amount) internal {
        uint256 elig = eligibleSupply();
        if (amount == 0) return;
        // fewer than 1,000 tokens held: burn instead (keeps the per-token accumulator far from overflow:
        // total rewards <= supply 1e27, so acc <= 1e27 * 1e36 / 1e21 = 1e42 and balance * acc <= 1e69)
        if (elig < 1_000 ether) { _burnFrom(address(this), amount); return; }
        accRewardPerToken += (amount * 1e36) / elig;
        rewardsDistributed += amount;
        emit RewardsAdded(amount, accRewardPerToken);
    }
    function claim() external {
        _settle(msg.sender);
        _checkpoint(msg.sender);
    }

    // ---------------------------------------------------------------- curve hooks
    function launch(address _pair) external {
        if (msg.sender != curve) revert NotCurve();
        pair = _pair;
        launched = true;
    }
    function burn(uint256 value) external {
        if (msg.sender != curve) revert NotCurve();
        _burnFrom(curve, value);
    }
    /// @notice the curve sends reward tokens here, then calls this to credit holders
    function distribute(uint256 amount) external {
        if (msg.sender != curve) revert NotCurve();
        _addRewards(amount);
    }

    // ---------------------------------------------------------------- internals
    function _burnFrom(address from, uint256 value) internal {
        uint256 b = balanceOf[from];
        if (b < value) revert Insufficient();
        balanceOf[from] = b - value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
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

    function _transfer(address from, address to, uint256 value) internal {
        if (!launched && to != curve && to != address(this) && _isContract(to)) revert NoContractsBeforeLaunch();
        // rewards earned so far land in both balances before they change
        _settle(from);
        _settle(to);

        uint256 b = balanceOf[from];
        if (b < value) revert Insufficient();
        unchecked { balanceOf[from] = b - value; }

        uint256 received = value;
        // creator taxes on Uniswap trades after graduation (buy: from the pair, sell: to the pair)
        if (launched && pair != address(0) && (from == pair || to == pair) && from != curve && to != curve) {
            uint256 mkt = (value * taxMarketing) / 10000;
            uint256 brn = (value * taxBurn) / 10000;
            uint256 rew = (value * taxRewards) / 10000;
            received = value - mkt - brn - rew;
            if (mkt > 0) {
                _settle(creator);
                balanceOf[creator] += mkt;
                emit Transfer(from, creator, mkt);
                _checkpoint(creator);
            }
            if (brn > 0) { totalSupply -= brn; emit Transfer(from, address(0), brn); }
            if (rew > 0) { balanceOf[address(this)] += rew; emit Transfer(from, address(this), rew); }
            if (mkt + brn + rew > 0) emit Taxed(from, to, mkt, brn, rew);
            balanceOf[to] += received;
            emit Transfer(from, to, received);
            if (rew > 0) _addRewards(rew);
        } else {
            balanceOf[to] += received;
            emit Transfer(from, to, received);
        }
        _checkpoint(from);
        _checkpoint(to);
    }
}
