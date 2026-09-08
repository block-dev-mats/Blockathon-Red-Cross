// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice One synthetic organisation, publisher, feed and versioned message series.
/// No message text, administration, proxies or key rotation.
contract CrisisRegistry is EIP712 {
    struct Message {
        bytes32 bodyHash;
        address sender;
        bytes32 organisation;
        bytes32 feed;
        bytes32 messageId;
        uint32 version;
        bytes32 previousDigest;
    }
    struct Record { bytes32 packageDigest; uint256 blockNumber; }

    bytes32 public constant MESSAGE_TYPEHASH = keccak256(
        "Message(bytes32 bodyHash,address sender,bytes32 organisation,bytes32 feed,bytes32 messageId,uint32 version,bytes32 previousDigest)"
    );
    address public immutable publisher;
    bytes32 public immutable organisation;
    bytes32 public immutable feed;
    bytes32 public immutable messageId;
    uint32 public headVersion;
    bytes32 public headDigest;
    mapping(uint32 => Record) public records;

    error Unauthorized();
    error WrongContext();
    error InvalidVersion();
    error InvalidSignature();
    event Published(uint32 indexed version, bytes32 indexed packageDigest);

    constructor(address publisher_, bytes32 organisation_, bytes32 feed_, bytes32 messageId_)
        EIP712("CrisisMessage", "1")
    {
        require(publisher_ != address(0) && publisher_.code.length == 0);
        publisher = publisher_;
        organisation = organisation_;
        feed = feed_;
        messageId = messageId_;
    }

    function context() external view returns (address, bytes32, bytes32, bytes32) {
        return (publisher, organisation, feed, messageId);
    }

    function head() external view returns (uint32, bytes32) { return (headVersion, headDigest); }

    function digest(Message calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            MESSAGE_TYPEHASH, m.bodyHash, m.sender, m.organisation,
            m.feed, m.messageId, m.version, m.previousDigest
        )));
    }

    function publish(Message calldata m, bytes calldata signature) external {
        if (msg.sender != publisher || m.sender != publisher) revert Unauthorized();
        if (m.organisation != organisation || m.feed != feed || m.messageId != messageId) revert WrongContext();
        if (m.version != headVersion + 1 || m.previousDigest != headDigest) revert InvalidVersion();
        bytes32 packageDigest = digest(m);
        if (ECDSA.recover(packageDigest, signature) != publisher) revert InvalidSignature();
        records[m.version] = Record(packageDigest, block.number);
        headVersion = m.version;
        headDigest = packageDigest;
        emit Published(m.version, packageDigest);
    }
}
