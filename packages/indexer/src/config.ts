import { readFileSync } from "node:fs";
import type { ContractAddresses } from "./types.js";

interface DeploymentFile {
  contracts?: Partial<ContractAddresses>;
}

function positiveInteger(value: string | undefined, name: string, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

export interface EnvironmentConfig {
  rpcUrl: string;
  databasePath: string;
  reportDatabasePath: string;
  corsOrigin: string;
  reportWorkerEnabled: boolean;
  reportPollIntervalMs: number;
  reportEmailGatewayUrl?: string;
  reportEmailGatewayToken?: string;
  contracts: ContractAddresses;
  startLedger: number;
  /** Optional historical starting ledger for backfill; falls back to startLedger. */
  fromLedger?: number;
  rollbackWindow: number;
  finalityLag: number;
  pollIntervalMs: number;
  port: number;
}

export function loadEnvironment(env = process.env): EnvironmentConfig {
  let deployed: DeploymentFile = {};
  if (env.INDEXER_DEPLOYMENT_FILE) {
    deployed = JSON.parse(readFileSync(env.INDEXER_DEPLOYMENT_FILE, "utf8")) as DeploymentFile;
  }
  const contracts = {
    paymentChannel:
      env.PAYMENT_CHANNEL_CONTRACT ?? deployed.contracts?.paymentChannel,
    escrow: env.ESCROW_CONTRACT ?? deployed.contracts?.escrow,
    rateLimiter: env.RATE_LIMITER_CONTRACT ?? deployed.contracts?.rateLimiter,
    agentWalletFactory:
      env.AGENT_WALLET_FACTORY_CONTRACT ??
      deployed.contracts?.agentWalletFactory,
  };
  for (const [name, address] of Object.entries(contracts)) {
    if (!address) throw new Error(`missing ${name} contract address`);
  }
  if (!env.SOROBAN_RPC_URL) throw new Error("missing SOROBAN_RPC_URL");

  const databasePath = env.INDEXER_DATABASE ?? "stellaragent-events.sqlite";
  const reportPollIntervalMs = positiveInteger(
    env.REPORT_POLL_INTERVAL_MS,
    "REPORT_POLL_INTERVAL_MS",
    5_000,
  );
  if (reportPollIntervalMs === 0) {
    throw new Error("REPORT_POLL_INTERVAL_MS must be greater than zero");
  }
  return {
    rpcUrl: env.SOROBAN_RPC_URL,
    databasePath,
    reportDatabasePath: env.REPORT_DATABASE ?? `${databasePath}.reports`,
    corsOrigin: env.AUDIT_API_CORS_ORIGIN ?? "*",
    reportWorkerEnabled: booleanValue(
      env.REPORT_WORKER_ENABLED,
      "REPORT_WORKER_ENABLED",
      true,
    ),
    reportPollIntervalMs,
    ...(env.REPORT_EMAIL_GATEWAY_URL
      ? { reportEmailGatewayUrl: env.REPORT_EMAIL_GATEWAY_URL }
      : {}),
    ...(env.REPORT_EMAIL_GATEWAY_TOKEN
      ? { reportEmailGatewayToken: env.REPORT_EMAIL_GATEWAY_TOKEN }
      : {}),
    contracts: contracts as ContractAddresses,
    startLedger: positiveInteger(env.INDEXER_START_LEDGER, "INDEXER_START_LEDGER"),
    ...(env.INDEXER_FROM_LEDGER
      ? { fromLedger: positiveInteger(env.INDEXER_FROM_LEDGER, "INDEXER_FROM_LEDGER") }
      : {}),
    rollbackWindow: positiveInteger(env.INDEXER_ROLLBACK_WINDOW, "INDEXER_ROLLBACK_WINDOW", 12),
    finalityLag: positiveInteger(env.INDEXER_FINALITY_LAG, "INDEXER_FINALITY_LAG", 1),
    pollIntervalMs: positiveInteger(env.INDEXER_POLL_INTERVAL_MS, "INDEXER_POLL_INTERVAL_MS", 5_000),
    port: positiveInteger(env.PORT, "PORT", 3_001),
  };
}
