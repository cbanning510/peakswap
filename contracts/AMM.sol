// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AMM
 * @notice Constant-product automated market maker (x * y = k).
 *         Deploy twice with different initial liquidity to create two
 *         independent pools for the Aggregator to arbitrage between.
 */
contract AMM is ReentrancyGuard {
    IERC20 public immutable token1;
    IERC20 public immutable token2;

    uint256 public reserve1;
    uint256 public reserve2;

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event AddLiquidity(
        address indexed provider,
        uint256 amount1,
        uint256 amount2,
        uint256 mintedShares
    );

    event RemoveLiquidity(
        address indexed provider,
        uint256 burnedShares,
        uint256 amount1,
        uint256 amount2
    );

    event Swap(
        address indexed user,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _token1, address _token2) {
        require(_token1 != _token2, "AMM: identical tokens");
        token1 = IERC20(_token1);
        token2 = IERC20(_token2);
    }

    // -------------------------------------------------------------------------
    // Liquidity
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit token1 and token2 to receive liquidity shares.
     *         The first deposit sets the pool ratio; subsequent deposits
     *         must match it exactly.
     * @param amount1 Amount of token1 to deposit.
     * @param amount2 Amount of token2 to deposit.
     * @return mintedShares Number of shares issued to the caller.
     */
    function addLiquidity(
        uint256 amount1,
        uint256 amount2
    ) external nonReentrant returns (uint256 mintedShares) {
        // Checks
        require(amount1 > 0 && amount2 > 0, "AMM: amounts must be > 0");

        if (totalShares == 0) {
            // First deposit: mint shares as geometric mean to avoid ratio gaming
            mintedShares = _sqrt(amount1 * amount2);
        } else {
            // Enforce existing ratio so late depositors cannot skew the pool
            require(
                amount1 * reserve2 == amount2 * reserve1,
                "AMM: amounts must match current ratio"
            );
            mintedShares = (amount1 * totalShares) / reserve1;
        }

        require(mintedShares > 0, "AMM: insufficient liquidity minted");

        // Effects
        shares[msg.sender] += mintedShares;
        totalShares += mintedShares;
        reserve1 += amount1;
        reserve2 += amount2;

        // Interactions
        token1.transferFrom(msg.sender, address(this), amount1);
        token2.transferFrom(msg.sender, address(this), amount2);

        emit AddLiquidity(msg.sender, amount1, amount2, mintedShares);
    }

    /**
     * @notice Burn liquidity shares and receive a proportional share of
     *         both token reserves.
     * @param _shares Number of shares to burn.
     * @return amount1 token1 returned to the caller.
     * @return amount2 token2 returned to the caller.
     */
    function removeLiquidity(
        uint256 _shares
    ) external nonReentrant returns (uint256 amount1, uint256 amount2) {
        // Checks
        require(_shares > 0, "AMM: shares must be > 0");
        require(shares[msg.sender] >= _shares, "AMM: insufficient shares");

        // Calculate proportional amounts before mutating state
        amount1 = (_shares * reserve1) / totalShares;
        amount2 = (_shares * reserve2) / totalShares;
        require(amount1 > 0 && amount2 > 0, "AMM: zero output");

        // Effects
        shares[msg.sender] -= _shares;
        totalShares -= _shares;
        reserve1 -= amount1;
        reserve2 -= amount2;

        // Interactions
        token1.transfer(msg.sender, amount1);
        token2.transfer(msg.sender, amount2);

        emit RemoveLiquidity(msg.sender, _shares, amount1, amount2);
    }

    // -------------------------------------------------------------------------
    // Swap
    // -------------------------------------------------------------------------

    /**
     * @notice Swap an exact amount of one token for the other.
     *         Uses the constant-product formula:
     *         amountOut = reserveOut * amountIn / (reserveIn + amountIn)
     * @param tokenIn  Address of the token being sold (must be token1 or token2).
     * @param amountIn Exact amount of tokenIn to sell.
     * @return amountOut Amount of the other token sent to the caller.
     */
    function swap(
        address tokenIn,
        uint256 amountIn
    ) external nonReentrant returns (uint256 amountOut) {
        // Checks
        require(
            tokenIn == address(token1) || tokenIn == address(token2),
            "AMM: invalid token"
        );
        require(amountIn > 0, "AMM: amountIn must be > 0");

        bool isToken1In = tokenIn == address(token1);

        (
            IERC20 tIn,
            IERC20 tOut,
            uint256 rIn,
            uint256 rOut
        ) = isToken1In
            ? (token1, token2, reserve1, reserve2)
            : (token2, token1, reserve2, reserve1);

        // Constant-product pricing (no fee for simplicity)
        amountOut = (rOut * amountIn) / (rIn + amountIn);
        require(amountOut > 0, "AMM: insufficient output");

        // Effects
        if (isToken1In) {
            reserve1 += amountIn;
            reserve2 -= amountOut;
        } else {
            reserve2 += amountIn;
            reserve1 -= amountOut;
        }

        // Interactions
        tIn.transferFrom(msg.sender, address(this), amountIn);
        tOut.transfer(msg.sender, amountOut);

        emit Swap(msg.sender, tokenIn, amountIn, amountOut);
    }

    // -------------------------------------------------------------------------
    // View helpers (used by the Aggregator)
    // -------------------------------------------------------------------------

    /**
     * @notice Quote the output amount for a given input without executing a swap.
     * @param tokenIn  Address of the token being sold.
     * @param amountIn Amount of tokenIn.
     * @return amountOut Expected output.
     */
    function getAmountOut(
        address tokenIn,
        uint256 amountIn
    ) external view returns (uint256 amountOut) {
        require(
            tokenIn == address(token1) || tokenIn == address(token2),
            "AMM: invalid token"
        );
        (uint256 rIn, uint256 rOut) = tokenIn == address(token1)
            ? (reserve1, reserve2)
            : (reserve2, reserve1);

        amountOut = (rOut * amountIn) / (rIn + amountIn);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Babylonian square root, used only for the initial share mint.
    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
