#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import {
  fromStroops,
  rankRoutes,
  type PaymentQuote,
  type RouteHop,
  type RouteQuote,
} from '@stellaragent/core';
import { getConfigPath, readConfigFile, writeConfigFile } from './config.js';
import { handlePayCommand } from './pay.js';
import { handleChannelCommand } from './channel.js';
import { handleLimitsCommand } from './limits.js';

const HELP = `StellarAgent CLI

Usage:
  stellaragent <command> [options]

Commands:
  route preview       Validate and display a routed-payment quote before confirmation
  config path         Print the configuration file path
  config get <key>    Get configuration value
  config set <k> <v>  Set configuration value
  pay                 Send payment with pre-flight outcome prediction
  channel             Manage payment channels (open, top-up, status, close)
  limits set          Configure rate limits (per hour / per day)
  limits show         Show remaining rate-limit headroom and window resets

Options:
  --help, -h          Show this help
  --version, -v       Show version
`;

export interface CliIO {
  stdout(message: string): void;
  stderr(message: string): void;
}

const terminalIO: CliIO = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

/** Execute the CLI without terminating the host process. */
export async function runCli(args: readonly string[], io: CliIO = terminalIO): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    io.stdout(HELP);
    return 0;
  }

  const command = args[0];

  // Route preview command
  if (command === 'route' && args[1] === 'preview') {
    const quotePath = optionValue(args, '--quote');
    if (!quotePath) {
      io.stderr('Missing required option: --quote <quote.json>');
      return 2;
    }

    try {
      const quote = parsePaymentQuote(JSON.parse(await readFile(quotePath, 'utf8')));
      io.stdout(formatQuotePreview(quote));
      if (args.includes('--confirm')) {
        io.stdout(`Confirmed route ${quote.route.id}. Pass this unchanged quote to payForAPI().`);
      } else {
        io.stdout('Preview only. Re-run with --confirm after reviewing the route and cost.');
      }
      return 0;
    } catch (error) {
      io.stderr(`Route preview failed: ${errorMessage(error)}`);
      return 1;
  }

  if (command === 'limits') {
    const action = args[1];
    if (action !== 'set' && action !== 'show') {
      io.stderr('Unknown limits action. Available: set, show');
      return 2;
    }
    return handleLimitsCommand({ action, args }, io);
  }


  // Config commands
  if (command === 'config') {
    const sub = args[1];
    if (sub === 'path') {
      io.stdout(getConfigPath());
      return 0;
    }
    if (sub === 'get') {
      const key = args[2];
      if (!key) {
        io.stderr('Usage: stellaragent config get <key>');
        return 2;
      }
      const cfg = await readConfigFile();
      const val = (cfg as Record<string, unknown>)[key];
      io.stdout(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? ''));
      return 0;
    }
    if (sub === 'set') {
      const key = args[2];
      const val = args[3];
      if (!key || val === undefined) {
        io.stderr('Usage: stellaragent config set <key> <value>');
        return 2;
      }
      const cfg = await readConfigFile();
      (cfg as Record<string, unknown>)[key] = val;
      await writeConfigFile(cfg);
      io.stdout(`Set ${key}=${val}`);
      return 0;
    }
    io.stderr('Unknown config command. Available: path, get, set');
    return 2;
  }

  // Pay command
  if (command === 'pay') {
    return handlePayCommand(
      {
        to: optionValue(args, '--to'),
        amount: optionValue(args, '--amount'),
        asset: optionValue(args, '--asset'),
        endpoint: optionValue(args, '--endpoint'),
        yes: args.includes('--yes') || args.includes('-y'),
        network: optionValue(args, '--network'),
      },
      io
    );
  }

  // Channel command
  if (command === 'channel') {
    const action = args[1] as 'open' | 'top-up' | 'status' | 'close';
    if (!action || !['open', 'top-up', 'status', 'close'].includes(action)) {
      io.stderr('Unknown channel action. Available: open, top-up, status, close');
      return 2;
    }
    return handleChannelCommand(
      {
        action,
        channelId: optionValue(args, '--channel-id') ?? optionValue(args, '--id'),
        amount: optionValue(args, '--amount'),
        recipient: optionValue(args, '--recipient') ?? optionValue(args, '--to'),
        json: args.includes('--json'),
        yes: args.includes('--yes') || args.includes('-y'),
        network: optionValue(args, '--network'),
      },
      io
    );
  }

  io.stderr(`Unknown command: ${args.join(' ')}`);
  io.stderr(HELP);
  return 2;
}

/** Human-readable preview shared by the command and tests. */
export function formatQuotePreview(quote: PaymentQuote): string {
  const route = quote.route;
  const sourceFee = BigInt(route.sourceAmount) * BigInt(route.totalFeeBps) / 10_000n;
  const warnings = quote.failures.length === 0
    ? 'none'
    : quote.failures.map((failure) => `${failure.providerId}/${failure.code}`).join(', ');

  return [
    'Routed payment preview',
    '──────────────────────',
    `You pay:             ${displayAmount(route.sourceAmount)} ${route.sourceAsset}`,
    `Recipient receives:  ${displayAmount(route.expectedDestinationAmount)} ${route.destinationAsset}`,
    `Minimum received:    ${displayAmount(quote.minimumDestinationAmount)} ${route.destinationAsset}`,
    `Route:               ${formatRoute(route)}`,
    `Estimated fee:       ${route.totalFeeBps} bps (~${displayAmount(sourceFee.toString())} ${route.sourceAsset})`,
    `Expected slippage:   ${route.expectedSlippageBps} bps`,
    `Reliability:         ${route.reliabilityBps} / 10000`,
    `Selector score:      ${route.score}`,
    `Quoted at ledger:    ${quote.quotedAtLedger}`,
    `Valid through:       ${quote.validUntilLedger}`,
    `Unavailable venues:  ${warnings}`,
  ].join('\n');
}

export function formatRoute(route: RouteQuote): string {
  const segments: string[] = [route.sourceAsset];
  for (const hop of route.hops) {
    const venue = venueLabel(hop);
    segments.push(`${venue} → ${hop.destinationAsset}`);
  }
  return segments.join(' → ');
}

function venueLabel(hop: RouteHop): string {
  if (hop.venue === 'path_payment') {
    const path = hop.path?.length ? ` via ${hop.path.join('/')}` : '';
    return `PATH[${hop.venueId}${path}]`;
  }
  return `${hop.venue.toUpperCase()}[${hop.venueId}]`;
}

function parsePaymentQuote(value: unknown): PaymentQuote {
  if (!isRecord(value) || !isRecord(value.route)) {
    throw new TypeError('quote JSON must contain a route object');
  }

  const minimum = requiredInteger(value.minimumDestinationAmount, 'minimumDestinationAmount');
  const quotedAtLedger = requiredLedger(value.quotedAtLedger, 'quotedAtLedger');
  const validUntilLedger = requiredLedger(value.validUntilLedger, 'validUntilLedger');
  if (validUntilLedger < quotedAtLedger) {
    throw new RangeError('validUntilLedger precedes quotedAtLedger');
  }

  const route = rankRoutes([value.route as unknown as RouteQuote])[0];
  if (!route) throw new RangeError('route is outside routing policy bounds');
  if (BigInt(minimum) > BigInt(route.expectedDestinationAmount)) {
    throw new RangeError('minimumDestinationAmount exceeds expected output');
  }

  return {
    route,
    minimumDestinationAmount: minimum,
    quotedAtLedger,
    validUntilLedger,
    failures: parseFailures(value.failures),
  };
}

function parseFailures(value: unknown): PaymentQuote['failures'] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('failures must be an array');
  return value.map((failure) => {
    if (!isRecord(failure) || typeof failure.providerId !== 'string' ||
      typeof failure.code !== 'string' || typeof failure.message !== 'string') {
      throw new TypeError('each failure must contain providerId, code, and message');
    }
    return failure as unknown as PaymentQuote['failures'][number];
  });
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredInteger(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical integer string`);
  }
  return value;
}

function requiredLedger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function displayAmount(amount: string): string {
  return fromStroops(BigInt(amount));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.env.NODE_ENV !== 'test') {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
