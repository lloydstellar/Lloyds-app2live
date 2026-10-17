'use strict';
// Who is calling: the device token on device routes, the app token on app routes. Only an
// unknown or revoked token gives a 401, because the device forgets its pairing on a 401. A device
// token on an app route is unknown there, and the other way round.

const { HttpError } = require('./http-util');
const { bearer, sha256 } = require('./tokens');

const DEVICE_401 = 'Unknown token. Pair this computer again.';
const APP_401 = 'Unknown token. Pair this app again.';
const SEEN_EVERY_MS = 60000; // last_seen_at is written at most once a minute

function makeAuth({ store, limits, clock }) {
  const iso = (ms) => new Date(ms).toISOString();

  function tokenHash(ctx, message) {
    const token = bearer(ctx.req.headers.authorization);
    if (!token) throw new HttpError(401, message);
    return sha256(token);
  }

  return {
    // The device row of the calling computer.
    device(ctx) {
      const device = store.deviceByToken(tokenHash(ctx, DEVICE_401));
      if (!device) throw new HttpError(401, DEVICE_401);
      ctx.who = `device=${device.id}`;
      limits.check('token', `device ${device.id}`);
      const now = clock();
      store.touchDevice(device.id, iso(now), iso(now - SEEN_EVERY_MS));
      return device;
    },

    // The app row of the calling app, with device_name.
    app(ctx) {
      const app = store.appByToken(tokenHash(ctx, APP_401));
      if (!app) throw new HttpError(401, APP_401);
      ctx.who = `app=${app.id}`;
      limits.check('token', `app ${app.id}`);
      const now = clock();
      store.touchApp(app.id, iso(now), iso(now - SEEN_EVERY_MS));
      // Which SDK version this app runs, so it shows before anything is ever phased out.
      if (ctx.client && ctx.client !== app.client) store.setAppClient(app.id, ctx.client);
      return app;
    },
  };
}

module.exports = { makeAuth, DEVICE_401, APP_401 };
