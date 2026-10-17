// One error class for everything the SDK can refuse or run into, so an app needs one catch.

/**
 * What went wrong, for an app to switch on. The message is always a short text in plain
 * English that the app can show to the user as it is.
 */
export type La2lErrorCode =
  | 'not_paired' // the token is unknown or revoked: pair again
  | 'bad_code' // the pairing code does not work
  | 'rate_limited' // too many calls: wait retryAfter seconds
  | 'server_full' // the server or this computer has no room: try later, or Import in Live first
  | 'bad_package' // the manifest or the package as a whole is refused
  | 'bad_wav' // a file is not a WAV file that Live can use
  | 'network' // the server could not be reached
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
