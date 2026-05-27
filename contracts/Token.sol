// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Token is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** 18;
    uint256 public constant COOLDOWN = 24 hours;

    mapping(address => uint256) public lastFaucetTime;

    event Faucet(address indexed recipient, uint256 amount);

    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply
    ) ERC20(name, symbol) {
        _mint(msg.sender, totalSupply);
    }

    /**
     * @notice Mint 1,000 tokens to the caller. Can only be called once every
     *         24 hours per address.
     */
    function faucet() external {
        require(
            block.timestamp >= lastFaucetTime[msg.sender] + COOLDOWN,
            "Faucet: cooldown not elapsed, please wait 24 hours"
        );

        lastFaucetTime[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);

        emit Faucet(msg.sender, FAUCET_AMOUNT);
    }
}
