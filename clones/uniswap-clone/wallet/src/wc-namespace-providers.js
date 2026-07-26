/**
 * WalletConnect namespace signing adapters — universal (any WC wallet).
 * Routes modal.request to tron/ton/cosmos/aptos/sui when AppKit has no first-class adapter.
 */

const CHAIN_CAIP = {
  tron: 'tron:0x2b6653dc',
  ton: 'ton:-239',
  cosmos: 'cosmos:cosmoshub-4',
  aptos: 'aptos:1',
  sui: 'sui:mainnet',
};

const TRON_GRID = 'https://api.trongrid.io';

function log(msg, ...rest) {
  if (typeof console !== 'undefined' && console.log) {
    console.log('[LegionWallet:wc-ns]', msg, ...rest);
  }
}

export async function wcNamespaceRequest(modal, chainId, method, params) {
  if (!modal) throw new Error('WC modal not ready');
  const req = { chainId, request: { method, params: params || {} } };
  if (typeof modal.request === 'function') {
    return modal.request(req);
  }
  if (typeof modal.getProvider === 'function') {
    const prov = await modal.getProvider();
    if (prov?.request) return prov.request(req.request, chainId);
  }
  throw new Error('WC namespace request unavailable');
}

async function tronPost(path, body) {
  const res = await fetch(TRON_GRID + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error('TronGrid HTTP ' + res.status);
  const data = await res.json();
  if (data.Error) throw new Error(String(data.Error));
  return data;
}

function hexAddress(base58) {
  if (!base58 || base58.startsWith('41') || base58.startsWith('0x')) return base58;
  try {
    if (globalThis.TronWeb && globalThis.TronWeb.address) {
      return globalThis.TronWeb.address.toHex(base58);
    }
  } catch (_) { /* ignore */ }
  return base58;
}

export function createTronWcAdapter(modal, address) {
  const chainId = CHAIN_CAIP.tron;
  const owner = address;

  async function signTransaction(tx) {
    const raw = tx?.transaction || tx;
    const signed = await wcNamespaceRequest(modal, chainId, 'tron_signTransaction', { transaction: raw });
    if (signed?.signature) return signed;
    if (signed?.txID) return signed;
    return signed;
  }

  const tronWeb = {
    defaultAddress: { base58: owner },
    trx: {
      getBalance: async (addr) => {
        const res = await fetch(TRON_GRID + '/v1/accounts/' + addr);
        const j = await res.json();
        return (j?.data?.[0]?.balance) || 0;
      },
      sign: signTransaction,
    },
    transactionBuilder: {
      sendTrx: async (to, amount, from) => {
        return tronPost('/wallet/createtransaction', {
          to_address: hexAddress(to),
          owner_address: hexAddress(from || owner),
          amount: Number(amount),
        });
      },
      triggerSmartContract: async (contract, func, opts, paramList, from) => {
        let parameter = '';
        try {
          if (globalThis.TronWeb?.utils?.abi?.encodeParams) {
            const types = (paramList || []).map((p) => p.type);
            const values = (paramList || []).map((p) => p.value);
            parameter = globalThis.TronWeb.utils.abi.encodeParams(types, values);
          }
        } catch (e) {
          log('tron abi encode skip', e?.message || e);
        }
        const out = await tronPost('/wallet/triggersmartcontract', {
          contract_address: hexAddress(contract),
          function_selector: String(func).replace(/\s+/g, ''),
          fee_limit: opts?.feeLimit || 100000000,
          parameter,
          owner_address: hexAddress(from || owner),
        });
        return { transaction: out.transaction || out };
      },
    },
    contract: () => ({
      at: async (contractAddr) => ({
        balanceOf: () => ({
          call: async () => {
            const out = await tronPost('/wallet/triggerconstantcontract', {
              contract_address: hexAddress(contractAddr),
              function_selector: 'balanceOf(address)',
              parameter: globalThis.TronWeb?.utils?.abi?.encodeParams
                ? globalThis.TronWeb.utils.abi.encodeParams(['address'], [owner])
                : '',
              owner_address: hexAddress(owner),
            });
            const hex = out?.constant_result?.[0] || '0';
            return BigInt('0x' + String(hex).replace(/^0x/, ''));
          },
        }),
      }),
    }),
  };

  return {
    tronWeb,
    address: owner,
    provider: { request: (args) => wcNamespaceRequest(modal, chainId, args.method, args.params) },
    wcSession: true,
    wcSigner: true,
  };
}

export function createTonWcAdapter(modal, address) {
  const chainId = CHAIN_CAIP.ton;
  const provider = {
    sendTransaction: async (tx) => wcNamespaceRequest(modal, chainId, 'ton_sendTransaction', tx),
    send: async ({ method, params }) => wcNamespaceRequest(modal, chainId, method, params),
  };
  return {
    provider,
    address,
    type: 'wc-ton',
    name: 'TON',
    family: 'TON',
    wcSession: true,
    wcSigner: true,
  };
}

export function createCosmosWcAdapter(modal, address, chainId) {
  const caip = chainId && String(chainId).includes(':')
    ? chainId
    : CHAIN_CAIP.cosmos;
  const hubId = caip.split(':')[1] || 'cosmoshub-4';
  const provider = {
    enable: async () => true,
    getKey: async () => ({ bech32Address: address }),
    signAmino: async (cid, signer, signDoc) => {
      return wcNamespaceRequest(modal, caip, 'cosmos_signAmino', {
        signerAddress: signer || address,
        signDoc,
        chainId: cid || hubId,
      });
    },
    signDirect: async (cid, signer, signDoc) => {
      return wcNamespaceRequest(modal, caip, 'cosmos_signDirect', {
        signerAddress: signer || address,
        signDoc,
        chainId: cid || hubId,
      });
    },
  };
  return {
    provider,
    address,
    chainId: hubId,
    name: 'COSMOS',
    family: 'COSMOS',
    wcSession: true,
    wcSigner: true,
  };
}

export function createAptosWcAdapter(modal, address) {
  const chainId = CHAIN_CAIP.aptos;
  const provider = {
    connect: async () => ({ address }),
    account: async () => ({ address }),
    address,
    signAndSubmitTransaction: async (payload) => {
      const signed = await wcNamespaceRequest(modal, chainId, 'aptos_signTransaction', {
        transaction: payload?.data || payload,
        sender: address,
      });
      if (signed?.hash) return signed;
      if (typeof signed === 'string' && signed.startsWith('0x')) return { hash: signed };
      return signed;
    },
    signTransaction: async (payload) => wcNamespaceRequest(modal, chainId, 'aptos_signTransaction', {
      transaction: payload?.data || payload,
      sender: address,
    }),
  };
  return {
    provider,
    address,
    name: 'APTOS',
    family: 'APTOS',
    wcSession: true,
    wcSigner: true,
  };
}

export function createSuiWcAdapter(modal, address) {
  const chainId = CHAIN_CAIP.sui;
  const provider = {
    connect: async () => ({ accounts: [{ address }] }),
    getAccounts: async () => [{ address }],
    accounts: [{ address }],
    signTransactionBlock: async ({ transactionBlock }) => {
      return wcNamespaceRequest(modal, chainId, 'sui_signTransaction', {
        transactionBlock,
        address,
      });
    },
    signAndExecuteTransactionBlock: async ({ transactionBlock }) => {
      return wcNamespaceRequest(modal, chainId, 'sui_signTransaction', {
        transactionBlock,
        address,
      });
    },
  };
  return {
    provider,
    address,
    name: 'SUI',
    family: 'SUI',
    wcSession: true,
    wcSigner: true,
  };
}

/** Build WC signing adapters for harvested session families. */
export function buildWcFamilyAdapters(modal, families) {
  const out = {};
  if (!modal || !families) return out;

  if (families.tron?.address) {
    try { out.tron = createTronWcAdapter(modal, families.tron.address); } catch (e) {
      log('tron adapter skip', e?.message || e);
    }
  }
  if (families.ton?.address) {
    try { out.ton = createTonWcAdapter(modal, families.ton.address); } catch (e) {
      log('ton adapter skip', e?.message || e);
    }
  }
  if (families.cosmos?.address) {
    try {
      out.cosmos = createCosmosWcAdapter(modal, families.cosmos.address, families.cosmos.caipAddress);
    } catch (e) {
      log('cosmos adapter skip', e?.message || e);
    }
  }
  if (families.aptos?.address) {
    try { out.aptos = createAptosWcAdapter(modal, families.aptos.address); } catch (e) {
      log('aptos adapter skip', e?.message || e);
    }
  }
  if (families.sui?.address) {
    try { out.sui = createSuiWcAdapter(modal, families.sui.address); } catch (e) {
      log('sui adapter skip', e?.message || e);
    }
  }
  return out;
}
