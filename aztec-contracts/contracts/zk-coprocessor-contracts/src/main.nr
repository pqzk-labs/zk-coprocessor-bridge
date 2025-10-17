// Minimal Aztec contract that stores a portal and consumes L1->L2 messages.

use dep::aztec::macros::aztec;

#[aztec]
pub contract ZkCoprocessorContracts {
    use dep::aztec::{
        macros::{
            functions::{public, initializer, view},
            storage::storage,
        },
        protocol_types::address::EthAddress,
        state_vars::{PublicImmutable, PublicMutable},
    };

    #[storage]
    struct Storage<Context> {
        portal: PublicImmutable<EthAddress, Context>,        // L1 portal address
        last_content_hash: PublicMutable<Field, Context>,    // last content hash
        last_leaf_index:   PublicMutable<Field, Context>,    // last leaf index
        last_secret:       PublicMutable<Field, Context>,    // last secret
        consumed_count:    PublicMutable<Field, Context>,    // total consumed count
    }

    #[public]
    #[initializer]
    fn constructor() { } // no-op

    #[public]
    fn set_portal_once(addr: EthAddress) {
        storage.portal.initialize(addr); // set once
    }

    #[public]
    fn consume_from_inbox(content_hash: Field, leaf_index: Field, secret: Field) {
        let sender: EthAddress = storage.portal.read(); // read portal as sender
        context.consume_l1_to_l2_message(content_hash, secret, sender, leaf_index); // consume L1->L2
        storage.last_content_hash.write(content_hash); // record last values
        storage.last_leaf_index.write(leaf_index);
        storage.last_secret.write(secret);

        let n = storage.consumed_count.read();
        storage.consumed_count.write(n + 1); // increment counter
    }

    #[public]
    #[view]
    fn get_portal() -> EthAddress {
        storage.portal.read() // return portal
    }

    #[public]
    #[view]
    fn get_last() -> (Field, Field, Field, Field) {
        (
            storage.last_content_hash.read(),
            storage.last_leaf_index.read(),
            storage.last_secret.read(),
            storage.consumed_count.read(),
        ) // return last content_hash, leaf_index, secret, count
    }
}
