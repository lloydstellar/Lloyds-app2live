# Errors

Every error is a `La2lError` with a `code` to switch on, a `message` in plain English to show as it is (mostly the server's own text), the HTTP `status`, and `retryAfter` in seconds where it applies.

| `code` | What happened | What to do |
|---|---|---|
| `not_paired` | No token, or the server no longer knows it: the user unpaired in Live, or paired this app again elsewhere. The token is forgotten. | Show the code field again. |
| `bad_code` | The pairing code does not work: wrong, used, or older than 10 minutes. | Ask for the code again; in Live, Pair app shows a new one. |
| `rate_limited` | Too many calls: more than 30 packages an hour, or 600 calls a minute. | Wait `retryAfter` seconds. |
| `server_full` | No room right now: over 1 GB waits for this computer ("Click Import in Live first"), over 2 GB from this address, or the server is full. | Ask the user to import in Live, or try later. |
| `bad_package` | LA2L would refuse the package: no sounds, more than 32, more than 200 MB, a sound without `kind`, a bad file name. | Fix the send; split it in more packages. |
| `bad_wav` | A file is not a WAV that Live can use: "Robot is not a usable WAV: This WAV file is compressed (format 85). Send plain PCM or float WAV." | Convert it with `toWav` or `wavFromAudioBuffer`. |
| `expired` | The package is gone: not imported within 24 hours, or not uploaded within an hour. | Send it again. |
| `import_failed` | LA2L in Live could not import the package. The message says why, per sound. | The package stays: a later Import in Live tries again. |
| `network` | The server could not be reached, or the connection broke, also after the retries. | Check the connection and try again. |
| `aborted` | Your `AbortSignal` stopped it. | |
| `server` | Any other answer of the server. | Show the message. |

A `delivery.imported()` that rejects with `import_failed` names the first sound that failed, for example "Live could not import it. Hit did not download: The file is gone. Send it again."
