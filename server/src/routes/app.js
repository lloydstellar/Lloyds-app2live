'use strict';
// The app side of the API (docs/server-api.md, "App side"): pairing with the code the device
// shows, and the calls an app makes with its app token.

const { HttpError, sendJson, readJson, cleanText } = require('../http-util');
const { newDeviceToken, newAppToken, newPublicId, sha256, normalizeCode } = require('../tokens');
const { ipKey } = require('../ratelimit');
const { cleanName } = require('../../../src/node/text');

// The same answer for a wrong, a used and an expired code, so a guesser learns nothing.
const WRONG_CODE = 'This code does not work. Check the code in Live.';

function appRoutes(router, { store, storage, auth, limits, clock, log }) {
  const iso = (ms) => new Date(ms).toISOString();

  router.add('POST', '/api/pair/claim', async (ctx) => {
    limits.check('claim', ipKey(ctx.ip));
    const body = await readJson(ctx.req);
    const code = normalizeCode(body.code);
    if (!code) throw new HttpError(404, WRONG_CODE);
    // The device shows this name: "Paired with LA2L Sender". Cleaned like a track name.
    const appName = cleanName(typeof body.app_name === 'string' ? body.app_name : '', 'App', 40);
    const appId = cleanText(body.app_id, 100);
    const now = iso(clock());

    const result = store.tx(() => {
      const p = store.waitingPairing(code, now);
      if (!p) return null;
      let device = p.device_ref ? store.deviceById(p.device_ref) : null;
      if (device && device.revoked_at) device = null; // unpaired since it asked for the code
      let deviceToken = p.token_plain;
      let newDevice = false;
      const replaced = [];
      let dropped = [];
      if (device) {
        store.updateDeviceInfo(device.id, { name: p.device_name, client: p.client, platform: p.platform });
      } else {
        // A computer without a valid token. Rows that are still active for it are dead: it lost
        // their token, for example by unpairing while offline. Revoke them with their apps;
        // those apps learn it from a 401 and pair again.
        for (const old of store.activeDevicesFor(p.device_id)) {
          dropped = dropped.concat(store.revokeDeviceAndPackages(old.id, now).packageIds);
          replaced.push(old.id);
        }
        deviceToken = newDeviceToken();
        const id = store.createDevice(
          { deviceId: p.device_id, name: p.device_name, client: p.client, platform: p.platform, tokenHash: sha256(deviceToken), test: p.test === 1 },
          now
        );
        device = { id };
        newDevice = true;
      }
      // Pairing again from the same installation replaces its old token.
      const revokedApps = appId ? store.revokeAppsWithAppId(device.id, appId, now) : 0;
      const appToken = newAppToken();
      const appRef = store.createApp({ deviceRef: device.id, name: appName, appId, publicId: newPublicId(), client: ctx.client, tokenHash: sha256(appToken) }, now);
      store.markPaired(p.id, { deviceRef: device.id, newDevice, appRef, appName, tokenPlain: deviceToken }, now);
      return { appToken, appRef, deviceRef: device.id, deviceName: p.device_name, newDevice, replaced, dropped, revokedApps };
    });
    if (!result) throw new HttpError(404, WRONG_CODE);

    for (const id of result.dropped) storage.removePackage(id);
    ctx.who = `app=${result.appRef}`;
    const parts = [`pairing claimed: app ${result.appRef} on ${result.newDevice ? 'new ' : ''}device ${result.deviceRef}`];
    if (result.replaced.length) parts.push(`replaces device ${result.replaced.join(', ')}`);
    if (result.revokedApps) parts.push(`replaces ${result.revokedApps} older token(s) of this app`);
    log(parts.join('; '));
    sendJson(ctx.res, 200, { app_token: result.appToken, device_name: result.deviceName });
  });

  // So an app can show "Paired with STUDIO-PC", and find out with a 401 that it was unpaired.
  router.add('GET', '/api/app/me', (ctx) => {
    const app = auth.app(ctx);
    sendJson(ctx.res, 200, { device_name: app.device_name, app_name: app.name, paired_at: app.created_at });
  });

  // The app forgets this computer. Packages it sent stay for the device.
  router.add('POST', '/api/app/unpair', async (ctx) => {
    const app = auth.app(ctx);
    await readJson(ctx.req);
    store.revokeApp(app.id, iso(clock()));
    log(`app ${app.id} unpaired`);
    sendJson(ctx.res, 200, { ok: true });
  });
}

module.exports = { appRoutes, WRONG_CODE };
