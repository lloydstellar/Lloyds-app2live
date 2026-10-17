'use strict';
// A warning when the packages take most of MAX_TOTAL_STORAGE_MB: a loud log line, at most once
// an hour while it lasts. Above the limit itself the server refuses new packages (routes/
// packages.js), so this is the moment to look at the disk and at who sends so much.

const HOUR = 3600000;
const GB = 1073741824;

const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

function makeStorageWatch({ config, store, clock, log }) {
  let warnedAt = null;
  const limit = config.maxTotalStorageBytes;
  const threshold = (limit * config.storageWarnPercent) / 100;

  return {
    // Logs the warning when it is due. Returns true when it did.
    check() {
      let used;
      try {
        used = store.bytesStored();
      } catch (e) {
        log(`ERROR storage check: ${e.message}`);
        return false;
      }
      const now = clock();
      // At most once an hour, also when the use goes up and down around the line.
      if (used < threshold || (warnedAt !== null && now - warnedAt < HOUR)) return false;
      warnedAt = now;
      const percent = Math.round((used / limit) * 100);
      log(
        `WARNING storage: packages take ${gb(used)} of ${gb(limit)} (${percent}%). ` +
          `New packages are refused above ${gb(limit)} (MAX_TOTAL_STORAGE_MB).`
      );
      return true;
    },
  };
}

module.exports = { makeStorageWatch };
