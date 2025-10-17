// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

// Wormhole Core
interface IWormhole {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
        uint8 guardianIndex;
    }

    struct VM {
        uint8  version;
        uint32 timestamp;
        uint32 nonce;
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint8  consistencyLevel;
        bytes  payload;
        uint32 guardianSetIndex;
        Signature[] signatures;
        bytes32 hash;
    }

    function parseAndVerifyVM(bytes calldata encodedVM)
        external
        view
        returns (VM memory vm, bool valid, string memory reason);
}

// Wormhole Core (EVM publish)
interface IWormholeCore is IWormhole {
    function publishMessage(
        uint32 nonce,
        bytes calldata payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence);

    function messageFee() external view returns (uint256);
}

// Aztec Inbox (Sepolia)
interface IInbox {
    struct L2Actor {
        bytes32 actor;
        uint256 version;
    }

    function sendL2Message(
        L2Actor calldata recipient,
        bytes32 content,
        bytes32 secretHash
    ) external returns (bytes32 key, uint256 leafIndex);
}

// Ownable
abstract contract Ownable {
    error NotOwner();
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    address public owner;

    constructor(address o) {
        owner = o;
        emit OwnershipTransferred(address(0), o);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address n) external onlyOwner {
        owner = n;
        emit OwnershipTransferred(msg.sender, n);
    }
}

/// @title ZkCoprocessorPortal
/// @notice Verifies Wormhole VAAs on Sepolia and enqueues L1→L2 messages to the Aztec Inbox.
/// @dev Prefer `consumeWithSecret(bytes,bytes32)`; `consume(bytes)` is for compatibility.
contract ZkCoprocessorPortal is Ownable {
    // Config
    IWormholeCore public immutable wormhole;
    uint16    public immutable trustedEmitterChain;

    // Mutable endpoints
    bytes32 public trustedEmitter;
    IInbox  public inbox;
    bytes32 public l2Instance;
    uint256 public rollupVersion;

    // Replay protection
    mapping(bytes32 => bool) public consumed;

    // Events
    event TrustedEmitterUpdated(bytes32 indexed emitter);
    event InboxUpdated(address indexed inbox);
    event L2InstanceUpdated(bytes32 indexed l2);
    event RollupVersionUpdated(uint256 indexed version);
    event VaaConsumed(bytes32 indexed vmHash, uint64 indexed sequence, bytes payload, bytes32 aztecL2Key);
    event InboxEnqueued(
        bytes32 indexed vmHash,
        uint64  indexed sequence,
        bytes32 contentFr,
        bytes32 key,
        uint256 leafIndex,
        bytes32 secretHash
    );
    event ReceiptPublished(uint64 indexed sequence, bytes payload);

    // BN254 field modulus
    uint256 private constant FR_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    constructor(
        address _wormhole,
        bytes32 _trustedEmitter,
        uint16  _trustedChain,
        address _inbox,
        bytes32 _l2Instance,
        uint256 _rollupVersion
    ) Ownable(msg.sender) {
        wormhole = IWormholeCore(_wormhole);
        trustedEmitter = _trustedEmitter;
        trustedEmitterChain = _trustedChain;
        inbox = IInbox(_inbox);
        l2Instance = _l2Instance;
        rollupVersion = _rollupVersion;
    }

    // Admin ops
    function setTrustedEmitter(bytes32 emitter) external onlyOwner {
        trustedEmitter = emitter;
        emit TrustedEmitterUpdated(emitter);
    }

    function setInbox(address _inbox) external onlyOwner {
        inbox = IInbox(_inbox);
        emit InboxUpdated(_inbox);
    }

    function setL2Instance(bytes32 _l2) external onlyOwner {
        l2Instance = _l2;
        emit L2InstanceUpdated(_l2);
    }

    function setRollupVersion(uint256 _ver) external onlyOwner {
        rollupVersion = _ver;
        emit RollupVersionUpdated(_ver);
    }

    /// @notice Sets Inbox, L2 instance, and rollup version.
    function setAztecEndpoints(address _inbox, bytes32 _l2, uint256 _ver) external onlyOwner {
        inbox = IInbox(_inbox);
        l2Instance = _l2;
        rollupVersion = _ver;
        emit InboxUpdated(_inbox);
        emit L2InstanceUpdated(_l2);
        emit RollupVersionUpdated(_ver);
    }

    // Helpers
    /// @dev Reduces 32 bytes to a BN254 field element.
    function _toField(bytes32 x) internal pure returns (bytes32) {
        uint256 n = uint256(x);
        if (n >= FR_MODULUS) {
            unchecked { n %= FR_MODULUS; }
        }
        return bytes32(n);
    }

    function _hasAztecEndpoints() internal view returns (bool) {
        return address(inbox) != address(0) && l2Instance != bytes32(0) && rollupVersion != 0;
    }

    // Main path
    /// @notice Legacy entry point (secretHash = 0).
    function consume(bytes calldata encodedVaa)
        external
        returns (bytes32 vmHash, uint64 sequence)
    {
        return consumeWithSecret(encodedVaa, bytes32(0));
    }

    /// @notice Verifies a VAA and enqueues an L1→L2 message to Aztec.
    function consumeWithSecret(bytes calldata encodedVaa, bytes32 secretHash)
        public
        returns (bytes32 vmHash, uint64 sequence)
    {
        (IWormhole.VM memory vm, bool ok, string memory reason) = wormhole.parseAndVerifyVM(encodedVaa);
        require(ok, reason);
        require(vm.emitterChainId == trustedEmitterChain, "WRONG_CHAIN");
        require(vm.emitterAddress == trustedEmitter, "WRONG_EMITTER");
        require(!consumed[vm.hash], "REPLAY");
        consumed[vm.hash] = true;

        // Maps payload hash to field.
        bytes32 contentFr = _toField(keccak256(vm.payload));

        bytes32 l2key = bytes32(0);
        if (_hasAztecEndpoints()) {
            IInbox.L2Actor memory recipient = IInbox.L2Actor({
                actor:   l2Instance,
                version: rollupVersion
            });

            (bytes32 key, uint256 leafIndex) = inbox.sendL2Message(recipient, contentFr, secretHash);
            l2key = key;
            emit InboxEnqueued(vm.hash, vm.sequence, contentFr, key, leafIndex, secretHash);
        }

        emit VaaConsumed(vm.hash, vm.sequence, vm.payload, l2key);
        return (vm.hash, vm.sequence);
    }

    // Return receipt
    /// @notice Publishes an Aztec completion receipt over Wormhole back to Solana.
    function publishReceipt(
        uint16 origEmitterChain,
        bytes32 origEmitter,
        uint64  origSequence,
        bytes32 contentFr,
        bytes32 aztecL2Key,
        uint256 leafIndex,
        bytes32 secretHash,
        bytes32 resultHash,
        uint8   consistency
    ) external payable onlyOwner returns (uint64 seq) {
        bytes memory payload = abi.encodePacked(
            uint8(1),
            origEmitterChain,
            origEmitter,
            origSequence,
            contentFr,
            aztecL2Key,
            leafIndex,
            secretHash,
            resultHash
        );

        uint256 fee = wormhole.messageFee();
        require(msg.value >= fee, "INSUFFICIENT_MSG_VALUE");
        seq = wormhole.publishMessage(0, payload, consistency);
        emit ReceiptPublished(seq, payload);
    }
}
