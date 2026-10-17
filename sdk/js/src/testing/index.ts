// la2l/testing: test an app without Ableton Live. Node.js only.
//
//   const receiver = await startTestReceiver();
//   const la2l = new LA2L({ appName: 'Web808', server: receiver.server, storage: memoryStorage() });
//   await la2l.pair(receiver.code);
//   const delivery = await la2l.send({ ... });
//   await delivery.imported(); // the test receiver imports it as Live would
//   const report = await receiver.nextReport(); // warp mode, tempo, length, track name per sound
//   await receiver.close();

import { LocalServer } from './local-server.js';
import { TestReceiver, type ReceiverReport } from '../receiver.js';
import { memoryStorage } from '../storage.js';

export { LocalServer } from './local-server.js';
export { TestReceiver, statusText, type ReceiverReport, type ReceivedSound, type TestReceiverOptions } from '../receiver.js';

export interface LocalTestReceiver {
  /** The address for the SDK's `server` option: http://127.0.0.1:<port>/api. */
  readonly server: string;
  /** The code an app pairs with now, as with the code LA2L shows in Live. A new one follows when an app used it or it ran out. */
  readonly code: string;
  /** What the test receiver did with every package so far, oldest first. */
  readonly reports: ReceiverReport[];
  /**
   * The oldest report not yet returned by nextReport, as soon as there is one. Rejects after
   * `timeoutMs` (default 15 seconds).
   */
  nextReport(timeoutMs?: number): Promise<ReceiverReport>;
  /** A new code, for one more app. */
  newCode(): Promise<string>;
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  name?: string;
  /** Called with every new code: the first, and one after a code ran out. */
  onCode?: (code: string) => void;
  /** Called with every report as it comes. */
  onReport?: (report: ReceiverReport) => void;
}

/**
 * Starts an LA2L server in memory on 127.0.0.1 with a test receiver paired to it: no internet,
 * no rate limits. Point the SDK at `server`, pair with `code`, and every package you send is
 * imported as LA2L in Live would, within a second.
 */
export async function startTestReceiver(options: StartOptions = {}): Promise<LocalTestReceiver> {
  const local = new LocalServer();
  const server = await local.start(options.port || 0);
  const reports: ReceiverReport[] = [];
  let read = 0;
  const waiting: (() => void)[] = [];
  let code = '';
  let closed = false;
  const receiver: TestReceiver = new TestReceiver({
    server,
    name: options.name || 'Test receiver',
    storage: memoryStorage(),
    pollMs: 300,
    appsMs: 0,
    onCode: (c) => {
      code = c;
      if (options.onCode) options.onCode(c);
    },
    // There is always a fresh code: after an app used one, and when one ran out.
    onPaired: () => {
      if (!closed) receiver.pair().catch(() => {});
    },
    onCodeEnded: () => {
      if (!closed) receiver.pair().catch(() => {});
    },
    onReport: (r) => {
      reports.push(r);
      if (options.onReport) options.onReport(r);
      for (const w of waiting.splice(0)) w();
    },
  });
  await receiver.pair();
  return {
    server,
    get code() {
      return code;
    },
    reports,
    nextReport(timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const take = () => {
          if (read < reports.length) {
            clearTimeout(timer);
            resolve(reports[read++]);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => reject(new Error(`No package arrived at the test receiver within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
        if (take()) return;
        const wait = () => {
          if (!take()) waiting.push(wait);
        };
        waiting.push(wait);
      });
    },
    async newCode() {
      return (await receiver.pair()) as string;
    },
    async close() {
      closed = true;
      receiver.close();
      await local.close();
    },
  };
}
