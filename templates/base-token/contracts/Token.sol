// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title {{PROJECT_NAME}} Token
/// @notice ERC-20 token with permit support, deployed on Base (chain 8453)
contract {{PROJECT_NAME}}Token is ERC20, ERC20Permit, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10 ** 18; // 1 billion

    constructor(
        string memory name,
        string memory symbol,
        address initialOwner,
        uint256 initialSupply
    )
        ERC20(name, symbol)
        ERC20Permit(name)
        Ownable(initialOwner)
    {
        require(initialSupply <= MAX_SUPPLY, "Exceeds max supply");
        _mint(initialOwner, initialSupply);
    }

    /// @notice Mint additional tokens (owner only, up to MAX_SUPPLY)
    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds max supply");
        _mint(to, amount);
    }
}
