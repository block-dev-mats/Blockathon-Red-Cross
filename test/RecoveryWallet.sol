// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
// Test-only EIP-7702 call path. Never deployed by application scripts.
contract RecoveryWallet {
    function execute(address target, bytes calldata data) external {
        require(tx.origin == address(this), "test wallet owner only");
        (bool ok,) = target.call(data);
        require(ok, "registry call failed");
    }
}
contract RecoveryRouter {
    function forward(address account, address target, bytes calldata data) external {
        RecoveryWallet(account).execute(target, data);
    }
}
