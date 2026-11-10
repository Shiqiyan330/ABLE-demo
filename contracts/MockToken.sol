// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 2;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, address recipient, uint256 supply) {
        name = name_; symbol = symbol_; totalSupply = supply; balanceOf[recipient] = supply;
        emit Transfer(address(0), recipient, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value; emit Approval(msg.sender, spender, value); return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value); return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= value, "allowance exceeded");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - value;
        _transfer(from, to, value); return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0) && balanceOf[from] >= value, "invalid transfer");
        balanceOf[from] -= value; balanceOf[to] += value; emit Transfer(from, to, value);
    }
}
