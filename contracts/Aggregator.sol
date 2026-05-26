// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./AMM.sol";

/**
 * @title Aggregator
 * @notice Routes swaps to whichever of two AMM pools returns the better rate.
 *         The Aggregator holds no token balances between transactions — it
 *         pulls tokenIn from the user, forwards it to the chosen AMM, and
 *         immediately sends the tokenOut back to the user in the same call.
 */
contract Aggregator is ReentrancyGuard, Ownable {
    AMM public immutable amm1;
    AMM public immutable amm2;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * @param user       Caller who initiated the swap.
     * @param tokenIn    Token sold.
     * @param tokenOut   Token received.
     * @param chosenAMM  Address of the AMM that executed the trade.
     * @param amountIn   Exact amount of tokenIn sold.
     * @param amountOut  Exact amount of tokenOut received.
     */
    event Swap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        address chosenAMM,
        uint256 amountIn,
        uint256 amountOut
    );

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _amm1 Address of the first deployed AMM pool.
    /// @param _amm2 Address of the second deployed AMM pool.
    constructor(address _amm1, address _amm2) Ownable(msg.sender) {
        require(_amm1 != address(0) && _amm2 != address(0), "Aggregator: zero address");
        require(_amm1 != _amm2, "Aggregator: identical AMMs");
        amm1 = AMM(_amm1);
        amm2 = AMM(_amm2);
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    /**
     * @notice Fetch quotes from both pools without executing anything.
     *         Call this from the frontend to display prices side-by-side
     *         and to indicate which pool will be used.
     * @param tokenIn  Token the user wants to sell.
     * @param amountIn Amount of tokenIn to sell.
     * @return amm1Out Amount of tokenOut amm1 would return.
     * @return amm2Out Amount of tokenOut amm2 would return.
     */
    function getQuotes(
        address tokenIn,
        uint256 amountIn
    ) external view returns (uint256 amm1Out, uint256 amm2Out) {
        amm1Out = amm1.getAmountOut(tokenIn, amountIn);
        amm2Out = amm2.getAmountOut(tokenIn, amountIn);
    }

    // -------------------------------------------------------------------------
    // Swap
    // -------------------------------------------------------------------------

    /**
     * @notice Swap tokenIn for tokenOut via the best-priced AMM.
     *
     *         Flow (pull → route → push):
     *           1. Pull amountIn of tokenIn from the caller.
     *           2. Approve the chosen AMM to spend those tokens.
     *           3. Call swap on the chosen AMM (AMM sends tokenOut here).
     *           4. Forward tokenOut to the caller.
     *
     * @param tokenIn      Token the caller wants to sell.
     * @param amountIn     Exact amount of tokenIn to sell.
     * @param minAmountOut Minimum acceptable output — reverts if the best
     *                     available quote is below this (slippage guard).
     * @return amountOut   Actual amount of tokenOut received by the caller.
     */
    function swap(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut
    ) external nonReentrant returns (uint256 amountOut) {
        // Checks
        require(amountIn > 0, "Aggregator: amountIn must be > 0");

        uint256 quote1 = amm1.getAmountOut(tokenIn, amountIn);
        uint256 quote2 = amm2.getAmountOut(tokenIn, amountIn);

        // Pick the AMM offering more tokenOut
        bool useAmm1 = quote1 >= quote2;
        AMM chosenAMM = useAmm1 ? amm1 : amm2;
        uint256 bestQuote = useAmm1 ? quote1 : quote2;

        require(bestQuote >= minAmountOut, "Aggregator: slippage exceeded");

        // Derive tokenOut from the chosen pool's token pair
        address tokenOut = tokenIn == address(chosenAMM.token1())
            ? address(chosenAMM.token2())
            : address(chosenAMM.token1());

        // Interactions (no Aggregator-owned state changes, so CEI collapses to
        // a safe pull-then-push sequence guarded by nonReentrant)

        // 1. Pull tokenIn from user to this contract
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        // 2. Approve the chosen AMM to pull tokenIn from this contract
        IERC20(tokenIn).approve(address(chosenAMM), amountIn);

        // 3. Execute the swap — AMM pulls tokenIn and sends tokenOut here
        amountOut = chosenAMM.swap(tokenIn, amountIn);

        // 4. Forward tokenOut to the caller
        IERC20(tokenOut).transfer(msg.sender, amountOut);

        emit Swap(msg.sender, tokenIn, tokenOut, address(chosenAMM), amountIn, amountOut);
    }
}
