import { estimateSecondsRemaining, fetchLedgerCloseEstimate } from '@stellaragent/core/ledgerTime';
import type { RateLimitStatus } from '@stellaragent/core';
import type { CliIO } from './index.js';

export interface LimitsCommandOptions {
  action: 'set' | 'show';
  args: readonly string[];
}

export interface RateLimitsClient {
  setLimits(perHour: number, perDay: number): Promise<void>;
  getStatus(): Promise<RateLimitStatus | null>;
}

export function formatLimitsStatus(status: RateLimitStatus | null, secondsPerLedger: number, tip: number): string {
  if (!status) return 'No rate limits configured. Run: stellaragent limits set --per-hour N --per-day M';
  const hourReset = status.hourWindowStartLedger + status.hourWindowLedgers;
  return [
    `hour: ${status.hourUsed}/${status.hourLimit} used, resets in ~${Math.round(estimateSecondsRemaining(hourReset - tip, secondsPerLedger))}s (ledger ${hourReset})`,
    `day: ${status.dayUsed}/${status.dayLimit} used, resets at ledger ${status.dayWindowStartLedger + status.dayWindowLedgers}`,
  ].join('\n');
}

export async function handleLimitsCommand(options: LimitsCommandOptions, io: CliIO): Promise<number> {
  const client = (globalThis as { __rateLimitsClient?: RateLimitsClient }).__rateLimitsClient;
  if (!client) { io.stderr('No SDK configured. Pass a funded agent client.'); return 1; }
  if (options.action === 'set') {
    const perHour = Number(optionAt(options.args, '--per-hour') ?? 0);
    const perDay = Number(optionAt(options.args, '--per-day') ?? 0);
    if (!perHour || !perDay) { io.stderr('limits set requires --per-hour N and --per-day M'); return 2; }
    await client.setLimits(perHour, perDay);
    io.stdout(`Rate limits set: ${perHour}/hour, ${perDay}/day`);
    return 0;
  }
  const estimate = await fetchLedgerCloseEstimate(process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org');
  io.stdout(formatLimitsStatus(await client.getStatus(), estimate.avgLedgerCloseSeconds, estimate.currentLedger));
  return 0;
}

function optionAt(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}
