// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice CRE receiver interface (the KeystoneForwarder calls onReport after checking DON signatures).
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @title SettlementEvidenceRegistry
/// @notice Append-only log of settlement evidence packs produced by the Predge "settlement-evidence"
///         CRE workflow. Each entry anchors the sha256 of a pack (the JSON a lawyer files) and the
///         sha256 of the signed Predge record it was built from, with the settlement status the DON
///         agreed on. Anyone holding a pack can recompute its hash and look it up here.
/// @dev Only the configured CRE forwarder can deliver reports. For `cre workflow simulate --broadcast`
///      that is the MockKeystoneForwarder of the target testnet; for a deployed workflow, the
///      KeystoneForwarder. Testnet only.
contract SettlementEvidenceRegistry is IReceiver, IERC165 {
    // status codes, same as PACK_STATUS in settlement-evidence/evidence.ts
    uint8 public constant OPEN_DISPUTE = 1;
    uint8 public constant UNRESOLVED = 2;
    uint8 public constant SETTLED_AS_PROPOSED = 3;
    uint8 public constant SETTLED_DIFFERENTLY = 4;
    uint8 public constant SETTLED_UNDISPUTED = 5;
    uint8 public constant RECORD_CHAIN_MISMATCH = 6;

    struct Entry {
        string marketId;
        bytes32 conditionId;
        bytes32 recordContentHash;
        uint8 status;
        uint8 disputeCount;
        bool openDispute;
        uint64 recordIssuedAt;
        uint64 anchoredAt;
    }

    address public owner;
    address public forwarder;

    mapping(bytes32 => Entry) public entries; // packHash => entry
    mapping(bytes32 => bytes32) public latestPackForCondition; // conditionId => latest packHash
    uint256 public count;

    event EvidenceAnchored(
        bytes32 indexed packHash,
        bytes32 indexed conditionId,
        string marketId,
        uint8 status,
        bool openDispute,
        bytes32 recordContentHash,
        uint64 recordIssuedAt
    );
    event ForwarderSet(address forwarder);

    error NotOwner();
    error NotForwarder(address sender);

    constructor(address forwarder_) {
        owner = msg.sender;
        forwarder = forwarder_;
        emit ForwarderSet(forwarder_);
    }

    function setForwarder(address f) external {
        if (msg.sender != owner) revert NotOwner();
        forwarder = f;
        emit ForwarderSet(f);
    }

    function onReport(bytes calldata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        (
            string memory marketId,
            bytes32 conditionId,
            bytes32 packHash,
            bytes32 recordContentHash,
            uint8 status,
            uint8 disputeCount,
            bool openDispute,
            uint64 recordIssuedAt
        ) = abi.decode(report, (string, bytes32, bytes32, bytes32, uint8, uint8, bool, uint64));

        entries[packHash] = Entry(
            marketId, conditionId, recordContentHash, status, disputeCount, openDispute, recordIssuedAt, uint64(block.timestamp)
        );
        latestPackForCondition[conditionId] = packHash;
        count++;
        emit EvidenceAnchored(packHash, conditionId, marketId, status, openDispute, recordContentHash, recordIssuedAt);
    }

    /// @notice True if this pack hash was anchored by the workflow.
    function isAnchored(bytes32 packHash) external view returns (bool) {
        return entries[packHash].anchoredAt != 0;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
