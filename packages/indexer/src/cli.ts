#!/usr/bin/env node
import { createQueryServer } from "./api.js";
import { loadEnvironment } from "./config.js";
import {
  EmailReportTransport,
  HttpEmailSender,
  ReportDeliveryStore,
  ScheduledReportService,
  WebhookReportTransport,
  eventStoreArtifactBuilder,
  type EmailSender,
} from "./delivery.js";
import { SorobanEventIndexer } from "./indexer.js";
import { EventStore } from "./store.js";

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function runReportWorker(
  service: ScheduledReportService,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await service.tick();
      if (Object.values(result).some((value) => value > 0)) {
        process.stdout.write(`Report worker ${JSON.stringify(result)}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `Report worker tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await delay(pollIntervalMs, signal);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "tail";
  if (command !== "catch-up" && command !== "tail") {
    throw new Error(
      "usage: stellaragent-indexer [catch-up|tail] [--from-ledger N]",
    );
  }
  const fromIndex = process.argv.indexOf("--from-ledger");
  const config = loadEnvironment();
  const fromLedger = fromIndex === -1 ? config.fromLedger : Number(process.argv[fromIndex + 1]);
  if (
    fromLedger !== undefined &&
    (!Number.isSafeInteger(fromLedger) || fromLedger < 1)
  ) {
    throw new Error("--from-ledger must be a positive integer");
  }
  const store = new EventStore(config.databasePath);
  const indexer = new SorobanEventIndexer({
    rpcUrl: config.rpcUrl,
    store,
    contracts: config.contracts,
    startLedger: config.startLedger,
    rollbackWindow: config.rollbackWindow,
    finalityLag: config.finalityLag,
    pollIntervalMs: config.pollIntervalMs,
  });

  const result = await indexer.catchUp(fromLedger);
  process.stdout.write(
    `Indexed ${result.eventCount} events through ledger ${result.throughLedger}\n`,
  );
  if (command === "catch-up") {
    store.close();
    return;
  }

  const deliveryStore = new ReportDeliveryStore(config.reportDatabasePath);
  const server = createQueryServer(store, {
    deliveryStore,
    corsOrigin: config.corsOrigin,
  });
  server.listen(config.port, () => {
    process.stdout.write(`Audit API listening on http://localhost:${config.port}\n`);
  });
  const controller = new AbortController();
  const missingEmailGateway: EmailSender = {
    async send() {
      throw new Error("REPORT_EMAIL_GATEWAY_URL is required for email destinations");
    },
  };
  const emailSender = config.reportEmailGatewayUrl
    ? new HttpEmailSender(
        config.reportEmailGatewayUrl,
        config.reportEmailGatewayToken,
      )
    : missingEmailGateway;
  const reportService = new ScheduledReportService({
    store: deliveryStore,
    artifactBuilder: eventStoreArtifactBuilder(store),
    transports: {
      webhook: new WebhookReportTransport(),
      email: new EmailReportTransport(emailSender),
    },
  });
  const shutdown = (): void => {
    controller.abort();
    indexer.stop();
    server.close(() => {
      deliveryStore.close();
      store.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await Promise.all([
    indexer.liveTail(controller.signal),
    ...(config.reportWorkerEnabled
      ? [runReportWorker(
          reportService,
          config.reportPollIntervalMs,
          controller.signal,
        )]
      : []),
  ]);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
