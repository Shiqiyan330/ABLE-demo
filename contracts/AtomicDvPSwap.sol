// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Atomic exchange of MMF units for settlement deposits.
/// @dev Payment to the final beneficiary and off-chain ledger posting are separate flows.
contract AtomicDvPSwap {
    address public immutable treasury;
    IERC20 public immutable mmfToken;
    IERC20 public immutable governmentBondToken;
    IERC20 public immutable corporateBondToken;
    IERC20 public immutable stablecoinToken;
    IERC20 public immutable depositToken;
    uint256 public nonce;
    bool public halted;
    mapping(address => bool) public authorizedExecutor;
    mapping(bytes32 => bool) public settledRequest;

    event SwapExecuted(bytes32 indexed requestId, address indexed counterparty,
        uint256 mmfIn, uint256 depositsOut, uint256 indexed nonce);
    event AssetSwapExecuted(bytes32 indexed requestId, address indexed assetToken, address indexed counterparty,
        uint256 assetIn, uint256 depositsOut, uint256 nonce);
    event HaltChanged(bool halted);

    error Unauthorized();
    error Halted();
    error InvalidRequest();
    error Expired();
    error Slippage();
    error TransferFailed();

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert Unauthorized();
        _;
    }

    constructor(address treasury_, address mmf_, address governmentBond_, address corporateBond_, address stablecoin_, address deposits_) {
        if (treasury_ == address(0) || mmf_ == address(0) || governmentBond_ == address(0) || corporateBond_ == address(0) || stablecoin_ == address(0) || deposits_ == address(0)) revert InvalidRequest();
        treasury = treasury_;
        mmfToken = IERC20(mmf_);
        governmentBondToken = IERC20(governmentBond_);
        corporateBondToken = IERC20(corporateBond_);
        stablecoinToken = IERC20(stablecoin_);
        depositToken = IERC20(deposits_);
        authorizedExecutor[treasury_] = true;
    }

    function setExecutor(address executor, bool allowed) external onlyTreasury {
        if (executor == address(0)) revert InvalidRequest();
        authorizedExecutor[executor] = allowed;
    }

    function setHalted(bool value) external onlyTreasury {
        halted = value;
        emit HaltChanged(value);
    }

    function swap(bytes32 requestId, address counterparty, uint256 mmfIn,
        uint256 depositsOut, uint256 minDepositsOut, uint256 deadline) external returns (uint256 executedNonce) {
        if (!authorizedExecutor[msg.sender]) revert Unauthorized();
        if (halted) revert Halted();
        if (requestId == bytes32(0) || counterparty == address(0) || mmfIn == 0 || depositsOut == 0 || settledRequest[requestId]) revert InvalidRequest();
        if (block.timestamp > deadline) revert Expired();
        if (depositsOut < minDepositsOut) revert Slippage();

        settledRequest[requestId] = true;
        executedNonce = ++nonce;
        if (!mmfToken.transferFrom(msg.sender, counterparty, mmfIn)) revert TransferFailed();
        if (!depositToken.transferFrom(counterparty, msg.sender, depositsOut)) revert TransferFailed();
        emit SwapExecuted(requestId, counterparty, mmfIn, depositsOut, executedNonce);
    }

    function swapAsset(bytes32 requestId, address assetToken, address counterparty, uint256 assetIn,
        uint256 depositsOut, uint256 minDepositsOut, uint256 deadline) external returns (uint256 executedNonce) {
        if (!authorizedExecutor[msg.sender]) revert Unauthorized();
        if (halted) revert Halted();
        if (requestId == bytes32(0) || counterparty == address(0) || assetIn == 0 || depositsOut == 0 || settledRequest[requestId]) revert InvalidRequest();
        if (assetToken != address(governmentBondToken) && assetToken != address(corporateBondToken) && assetToken != address(stablecoinToken)) revert InvalidRequest();
        if (block.timestamp > deadline) revert Expired();
        if (depositsOut < minDepositsOut) revert Slippage();

        settledRequest[requestId] = true;
        executedNonce = ++nonce;
        if (!IERC20(assetToken).transferFrom(msg.sender, counterparty, assetIn)) revert TransferFailed();
        if (!depositToken.transferFrom(counterparty, msg.sender, depositsOut)) revert TransferFailed();
        emit AssetSwapExecuted(requestId, assetToken, counterparty, assetIn, depositsOut, executedNonce);
    }
}
