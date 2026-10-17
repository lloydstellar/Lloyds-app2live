// One error class for everything the SDK can refuse or run into, so an app needs one catch.

/**
 * What went wrong, for an app to switch on. The message is always a short text in plain
 * English that the app can show to the user as it is.
 */
export type La2lErrorCode =
  | 'not_paired' // no token, or the server no longer knows it: show the pair screen
  | 'bad_code' // the pairing code does not work
  | 'rate_limited' // too many calls: wait retryAfter seconds
  | 'server_full' // the server or this computer has no room: try later, or Import in Live first
  | 'bad_package' // the server or LA2L would refuse the package as a whole
  | 'bad_wav' // a file is not a WAV file that Live can use
  | 'expired' // the package is gone: it expired, or it was not uploaded in time
  | 'import_failed' // LA2L in Live could not import the package
  | 'network' // the server could not be reached, or the connection broke off
  | 'aborted' // the app stopped it with an AbortSignal
  | 'server'; // any other answer from the server

export class La2lError extends Error {
  readonly code: La2lErrorCode;
  /** The HTTP status of the server's answer, or null when there was none. */
  readonly status: number | null;
  /** Seconds to wait before trying again, from Retry-After, or null. */
  readonly retryAfter: number | null;

  constructor(code: La2lErrorCode, message: string, options: { status?: number | null; retryAfter?: number | null } = {}) {
    super(message);
    this.name = 'La2lError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }
}
