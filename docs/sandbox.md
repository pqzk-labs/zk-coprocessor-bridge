# ZK Coprocessor Bridge — Sandbox Test ⚙️

This document summarizes the minimal steps required to run and verify the ZK Coprocessor Bridge using the Aztec Sandbox.

## Environment Note ⚠️

During testing:

- **Linux (native, manual sandbox)** → the Aztec sandbox API did **not** work correctly with this project setup.  
- **Windows + WSL2 + Docker Desktop** → sandbox + PXE worked normally.

Working endpoints:

- Aztec Node: `http://host.docker.internal:8080`
- L1 RPC (anvil): `http://host.docker.internal:8545`

This guide documents only the environment that was confirmed to work.


## 1. Start Sandbox ▶️
```
aztec start --sandbox
```
Aztec node becomes available at: http://host.docker.internal:8080

## 2. Import Test Accounts
```
aztec-wallet import-test-accounts
```
We use: accounts:test0

## 3. Deploy the Aztec Contract
```
cd aztec-contracts/contracts/zk-coprocessor-contracts
export ART=target/zk-coprocessor-contracts.json

aztec-wallet deploy "$ART" \
  --from accounts:test0 \
  --payment method=fee_juice,feePayer=test0
```
Save: AZTEC_CONTRACT=0x...

## 4. Deploy the L1 Portal (Foundry)
Environment variables:
```
export RPC_URL=http://host.docker.internal:8545
export PRIVATE_KEY=<anvil key>
export INBOX=<from `aztec get-node-info`>
export ROLLUP=<from `aztec get-node-info`>
export AZTEC_CONTRACT=0x...
```
Deploy:
```
forge create --broadcast \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  src/SandboxPortal.sol:SandboxPortal \
  --constructor-args $INBOX $AZTEC_CONTRACT $ROLLUP
```
Save: PORTAL_ADDRESS=0x...

## 5. Register Portal in Aztec
Convert portal address to field element:
```
export PORTAL_32B=<32-byte hex of portal>
```
Register:
```
aztec-wallet send set_portal_once \
  -ca $AZTEC_CONTRACT \
  --args "$PORTAL_32B" \
  --from accounts:test0 \
  --payment method=fee_juice,feePayer=test0
```
## 6. Build the App 🧩
```
cd apps/
npm install
npm run build
```
Environment variables:
```
RPC_URL=http://host.docker.internal:8545
PORTAL_ADDRESS=0x...
AZTEC_CONTRACT=0x...
AZTEC_NODE_URL=http://host.docker.internal:8080
AZTEC_FROM=accounts:test0
AZTEC_PAYMENT=method=fee_juice,feePayer=test0
PRIVATE_KEY=<same key>
```
## 7. Enqueue (L1 → L2)
```
npm run sandbox -- enqueue --payload "hello sandbox"

```
Example output:
```
{
  "contentFr": "0x...",
  "leafIndex": "161",
  "secretHash": "0x...",
  "secretFr": "0x..."
}
```
Save all values.

## 8. Consume (L2)
```
npm run sandbox -- consume \
  --content-fr <contentFr> \
  --leaf-index <leafIndex> \
  --secret-fr <secretFr>
```
Success → the L2 contract consumed the L1 message.

## 9. Done ✅
You have verified:
- L1 → Portal → Inbox → L2 message delivery
- Secret-hash validation
- Noir contract properly consumes messages
- Full ZK Coprocessor Bridge flow works in sandbox
