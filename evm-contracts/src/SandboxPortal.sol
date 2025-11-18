// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

import "./ZkCoprocessorPortal.sol";

contract SandboxPortal is ZkCoprocessorPortal {
    uint64 public devSeq;

    constructor(address _inbox, bytes32 _l2Instance, uint256 _rollupVersion)
        ZkCoprocessorPortal(address(0), bytes32(0), 0, _inbox, _l2Instance, _rollupVersion)
    {}

    function devConsume(bytes calldata payload, bytes32 secretHash)
        external
        onlyOwner
        returns (bytes32 vmHash, uint64 sequence)
    {
        vmHash = keccak256(payload);
        require(!consumed[vmHash], "REPLAY");
        consumed[vmHash] = true;

        bytes32 contentFr = _toField(keccak256(payload));
        sequence = ++devSeq;

        bytes32 l2key = bytes32(0);
        if (_hasAztecEndpoints()) {
            IInbox.L2Actor memory r = IInbox.L2Actor({ actor: l2Instance, version: rollupVersion });
            (bytes32 key, uint256 leafIndex) = inbox.sendL2Message(r, contentFr, secretHash);
            l2key = key;
            emit InboxEnqueued(vmHash, sequence, contentFr, key, leafIndex, secretHash);
        }
        emit VaaConsumed(vmHash, sequence, payload, l2key);
    }
}
