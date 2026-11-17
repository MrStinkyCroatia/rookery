// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title RookeryToken — ERC-20 launched by RookeryPad (bonding curve -> V2 pair).
/// @notice Based on StonkTokenV2, reduced to Rookery economics:
///   - fixed supply, minted once to the pad; no mint, no owner, no blacklist;
///   - before graduation NOTHING can be sent to the (pre-computed) V2 pair, so
///     nobody can pre-seed the pool and grief the graduation price;
///   - after graduation an IMMUTABLE swap tax applies ONLY to trades against the
///     pair: 0.5% platform (-> burn reserve) + optional creator tax (max 3%);
///     wallet-to-wallet transfers are never taxed;
///   - optional anti-snipe max wallet that switches itself off 30 min after
///     trading opens.
contract RookeryToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable pad;
    address public immutable pair;                 // predicted V2 pair (CREATE2)
    address public immutable collector;            // platform burn reserve
    address public immutable creatorWallet;
    uint16  public constant PLATFORM_BPS = 50;     // 0.5%
    uint16  public immutable creatorBps;           // 0 - 300
    uint256 public immutable maxWallet;            // 0 = off
    uint64  public constant MAX_WALLET_WINDOW = 30 minutes;
    uint64  public tradingStart;                   // set once at graduation
    mapping(address => bool) public capExempt;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event TradingOpened(uint64 at);
    event Swept(uint256 toCollector, uint256 toCreator);

    constructor(
        string memory _name, string memory _symbol, uint256 _supply,
        address _factory, address _weth, bytes32 _pairInitHash,
        address _collector, uint16 _creatorBps, address _creatorWallet, uint256 _maxWallet
    ) {
        require(_creatorBps <= 300, "RKT: creator tax > 3%");
        require(_creatorBps == 0 || _creatorWallet != address(0), "RKT: creator wallet");
        // the V2 pair address is deterministic (CREATE2 in the factory)
        (address t0, address t1) = address(this) < _weth ? (address(this), _weth) : (_weth, address(this));
        address _pair = address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff", _factory, keccak256(abi.encodePacked(t0, t1)), _pairInitHash)))));
        name = _name; symbol = _symbol; totalSupply = _supply;
        pad = msg.sender; pair = _pair; collector = _collector;
        creatorBps = _creatorBps; creatorWallet = _creatorWallet;
        maxWallet = (_maxWallet == 0 || _maxWallet >= _supply) ? 0 : _maxWallet;
        capExempt[msg.sender] = true; capExempt[_pair] = true; capExempt[DEAD] = true;
        capExempt[address(this)] = true;
        balanceOf[msg.sender] = _supply;
        emit Transfer(address(0), msg.sender, _supply);
    }

    function totalTaxBps() public view returns (uint16) { return PLATFORM_BPS + creatorBps; }
    function tradingOpen() public view returns (bool) { return tradingStart != 0; }

    function openTrading() external {
        require(msg.sender == pad, "RKT: only pad");
        if (tradingStart == 0) { tradingStart = uint64(block.timestamp); emit TradingOpened(tradingStart); }
    }

    /// @notice anyone can push accrued taxes out: platform share -> burn reserve, creator share -> creator.
    function sweep() external returns (uint256 toCollector, uint256 toCreator) {
        uint256 bal = balanceOf[address(this)];
        if (bal == 0) return (0, 0);
        toCreator = bal * creatorBps / totalTaxBps();
        toCollector = bal - toCreator;
        _move(address(this), collector, toCollector);
        _move(address(this), creatorWallet, toCreator);
        emit Swept(toCollector, toCreator);
    }

    // ---------------------------------- ERC-20 ----------------------------------
    function transfer(address to, uint256 value) external returns (bool) { _transfer(msg.sender, to, value); return true; }
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value; emit Approval(msg.sender, spender, value); return true;
    }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "RKT: allowance");
            unchecked { allowance[from][msg.sender] = a - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _capActive() internal view returns (bool) {
        if (maxWallet == 0) return false;
        if (tradingStart == 0) return true;
        return block.timestamp < tradingStart + MAX_WALLET_WINDOW;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "RKT: zero to");
        uint256 tax;
        if (tradingStart == 0) {
            // pre-graduation: the pool may only be seeded by the pad itself
            require(to != pair || from == pad, "RKT: pool locked until graduation");
        } else if ((from == pair || to == pair) && from != pad && to != pad) {
            tax = value * totalTaxBps() / 10000;
        }
        _move(from, address(this), tax);
        _move(from, to, value - tax);
        if (_capActive() && !capExempt[to]) require(balanceOf[to] <= maxWallet, "RKT: max wallet");
    }

    function _move(address from, address to, uint256 value) internal {
        if (value == 0) return;
        uint256 bal = balanceOf[from];
        require(bal >= value, "RKT: balance");
        unchecked { balanceOf[from] = bal - value; balanceOf[to] += value; }
        emit Transfer(from, to, value);
    }
}
