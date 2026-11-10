// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReserveAsset {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Local simulation token issued only against escrowed central-bank reserves.
contract ReserveBackedToken {
    string public constant name = "Wholesale CBDC Settlement Token";
    string public constant symbol = "wCBDC";
    uint8 public constant decimals = 2;
    address public immutable issuer;
    IReserveAsset public immutable reserveAsset;
    uint256 public totalSupply;
    uint256 public totalReserves;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event ReservesLockedAndIssued(address indexed recipient, uint256 amount, uint256 totalReserves);
    event Redeemed(address indexed holder, address indexed reserveRecipient, uint256 amount);

    error Unauthorized();
    error InvalidAmount();
    error TransferFailed();
    error InsufficientBalance();

    constructor(address issuer_, address reserveAsset_) {
        if (issuer_ == address(0) || reserveAsset_ == address(0)) revert Unauthorized();
        issuer = issuer_;
        reserveAsset = IReserveAsset(reserveAsset_);
    }

    function issueAgainstReserves(address recipient, uint256 amount) external {
        if (msg.sender != issuer) revert Unauthorized();
        if (recipient == address(0) || amount == 0) revert InvalidAmount();
        if (!reserveAsset.transferFrom(issuer, address(this), amount)) revert TransferFailed();
        totalReserves += amount;
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
        emit ReservesLockedAndIssued(recipient, amount, totalReserves);
    }

    function redeemAgainstReserves(uint256 amount, address reserveRecipient) external {
        if (amount == 0 || reserveRecipient == address(0)) revert InvalidAmount();
        if (balanceOf[msg.sender] < amount || totalReserves < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalReserves -= amount;
        if (!reserveAsset.transfer(reserveRecipient, amount)) revert TransferFailed();
        emit Transfer(msg.sender, address(0), amount);
        emit Redeemed(msg.sender, reserveRecipient, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address from, address recipient, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientBalance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, recipient, amount);
        return true;
    }

    function _transfer(address from, address recipient, uint256 amount) private {
        if (recipient == address(0)) revert InvalidAmount();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[recipient] += amount;
        emit Transfer(from, recipient, amount);
    }
}
