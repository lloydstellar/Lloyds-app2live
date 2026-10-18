# la2l-server

The server of Lloyd's App2Live. Apps pair with the LA2L device in Ableton Live through it and send it their sounds; the device picks them up when you click **Import**.

- API: `https://lloydstellar.nl/la2l/api`, described in [docs/server-api.md](../docs/server-api.md). The package format is [docs/manifest.md](../docs/manifest.md).
- LA2L Sender, a page that pairs and sends sounds from a browser (WAV, or mp3, m4a and ZIP files that it turns into WAV): `https://lloydstellar.nl/la2l/`. It is also the reference client for apps (`public/sender.js`). Installed from Chrome on Android it is in the share menu of other apps. With `?big` it also sends a file of 150 MB that it makes itself, to test a long upload from a phone.
- The test receiver, a page that stands in for LA2L in Live, so a developer can test an app without Ableton: `https://lloydstellar.nl/la2l/receiver`.
- The SDK for the browser, built from `sdk/js` (the npm package `la2l`): `https://lloydstellar.nl/la2l/vendor/la2l.js`, the Send to Live button in `vendor/la2l-button.js`, and the test receiver of the page in `vendor/la2l-receiver.js`. LA2L Sender itself runs on it.
- Web808, the drum machine example of the SDK, from `../examples/web-drum-machine`: `https://lloydstellar.nl/la2l/examples/drum-machine/`.

It is Node.js 24 with no npm packages, in one Docker container on the VPS behind nginx, which does TLS. The container listens on `127.0.0.1:8787` only. Everything it keeps is in the Docker volume `la2l-server_la2l-data`: the SQLite database `la2l.db` and the WAV files of packages that wait for Live.

All commands below are run in this folder, on the VPS `~/la2l-server/server`.

## Install

On lloydstellar.nl this is done. On a new machine with Docker and nginx:

```bash
git clone https://github.com/lloydstellar/Lloyds-app2live.git ~/la2l-server
cd ~/la2l-server/server
bash deploy/update.sh                  # builds the image and starts the container
bash deploy/install-nginx.sh --check   # shows what it will change in nginx
sudo bash deploy/install-nginx.sh      # adds /la2l/ to the 443 server block of lloydstellar.nl
```

`install-nginx.sh` copies [deploy/nginx-la2l.conf](deploy/nginx-la2l.conf) to `/etc/nginx/snippets/la2l.conf` and includes it in the site. It backs up the site file first, reloads nginx only when `nginx -t` passes, and puts everything back when it fails. `--domain` picks another domain, `--remove` takes LA2L out again.

Then check:

```bash
curl -sS https://lloydstellar.nl/la2l/api/health    # {"ok":true,"name":"la2l-server","version":"..."}
curl -sSI https://lloydstellar.nl/la2l/ | grep -iE '^(HTTP|content-type)'   # 200, text/html: the Sender page
```

In Live, **Settings > Self test** should then say `server OK`.

### Settings

Without a `.env` file the defaults hold, and they are right for lloydstellar.nl. [.env.example](.env.example) lists every setting with its default and what it does. To change one, copy it to `.env`, edit it, and run `bash deploy/update.sh`. A plain `docker compose restart` does not read `.env` again. A wrong value stops the server at start with a log line that names the setting, for example `la2l-server: PORT must be a whole number from 0 to 65535, not "x".`

`.env` stays on the VPS: git ignores it.

## Update

```bash
cd ~/la2l-server/server
git pull
bash deploy/update.sh
```

`update.sh` saves the log of the current container to `~/la2l-server-logs` (Docker throws it away with the container), backs up the database (see [Backups](#backups)), builds the image, starts the new container, and waits for its health check. It ends with the start lines of the new server and the answer of `/api/health`, which shows the new version.

To go back to an earlier version, check it out and run the script again:

```bash
git log --oneline                      # find the commit
git checkout <commit>
bash deploy/update.sh
git checkout main                      # later, to follow main again
```

The database has a schema version. A server that is older than its database refuses to start with `The database is from a newer la2l-server (schema 2, this one knows 1). Update the server.` Then either go forward again, or restore the backup that `update.sh` made just before the update that changed the schema (see [Restore](#restore); it also works while the server keeps restarting). Server 0.7.0 brought schema 2, so going back from 0.7.0 to 0.6.0 or older takes that backup, and loses what changed since.

## Run it on your own computer

Node.js 24 is enough:

```bash
cd server
npm test                                         # the server tests
HOST=127.0.0.1 DATA_DIR=./data npm start
```

The Sender page is then at `http://localhost:8787/`. The device can use it too: set `serverUrl` in its `settings.json` to `http://localhost:8787/api` (the device allows plain http only for localhost). `server/data/` is ignored by git.

## Backups

```bash
bash deploy/backup.sh
```

This copies the database to `~/la2l-server-backups/la2l-<date>-<time>.db` (UTC), checks the copy, and keeps the newest 30. It works while the server runs, and also when it is stopped or keeps restarting. `update.sh` makes one before every update. To change the folder, set `LA2L_BACKUP_DIR`.

A backup holds what is hard to make again: which computers and apps are paired, and the results apps still read. It does not hold the WAV files. They wait 24 hours at most, and an app can send them again. The tokens are stored as hashes. Only during a pairing, until the device has picked up its token or the code has run out, does the database also hold that device token. So treat a backup like the server itself: the folder is only readable by you, and a copy that leaves the VPS needs the same care.

For a backup every night, add this line with `crontab -e` (the folder exists after the first backup):

```
17 3 * * * cd "$HOME/la2l-server/server" && bash deploy/backup.sh >>"$HOME/la2l-server-backups/backup.log" 2>&1
```

### Restore

```bash
bash deploy/restore.sh ~/la2l-server-backups/la2l-20261017-031700.db
```

First it checks the backup with the code of the server that will open it: a damaged file, or one from a newer server, is refused before anything changes. Then it asks you to type `yes` (`--yes` skips the question), stops the server, backs up the database as it is now, puts the backup in place and starts the server again. It works whether the server runs, is stopped, or keeps restarting. At the end it prints how to undo the restore.

When something fails before the database is replaced, the server starts again with its own database. When the database as it is now cannot be copied (because it is damaged, for example), its files stay in the volume as `la2l.db.before-restore`; to restore that one later, copy it out first with `docker run --rm -v la2l-server_la2l-data:/data --entrypoint cat la2l-server:local /data/la2l.db.before-restore >~/la2l-before-restore.db`.

What happened after the backup is lost. A computer or app that paired since then gets a 401 and must pair again: in Live that is **Pair app**, on the Sender page the code screen. A package that was waiting and whose files are no longer there counts as expired; the start log says how many with `cleanup: 1 package(s) whose files were gone`. It may have reached Live after the backup was made, so check Live before the app sends it again. An upload that was still going on asks for such a file again when the app commits it.

On a new machine: install first (see [Install](#install)), then restore.

## Logs

```bash
docker compose logs -f --tail=200            # follow the log
docker logs la2l-server 2>&1 | grep ERROR    # the errors of a running server
ls ~/la2l-server-logs                        # the logs of earlier containers
```

Docker keeps up to 5 files of 10 MB per container (set in `compose.yaml`). A new build makes a new container with an empty log; `update.sh` saves the old one to `~/la2l-server-logs` and keeps the last 30. `docker compose restart` keeps the log.

Every line starts with the time in UTC. Only a server that cannot start writes a line without it: `la2l-server: ...` for a wrong setting, `la2l-server could not start: ...` for anything else, such as a database from a newer server. There is one line per request:

```
2026-10-17T14:31:05.120Z GET /api/packages/:id/files/:file 200 18.4ms in=0 out=1693484 device=7 203.0.113.7
2026-10-17T14:31:09.481Z POST /api/packages 201 12.0ms in=532 out=247 app=8 203.0.113.9 client="la2l-js/0.1.0 (Web808)"
```

That is the method and the route, the status (`aborted` added when the client went away before the end), how long it took, the bytes that came in and went out, who called (`device=7` and `app=8` are the row numbers in the database, `-` is no token), and the client's address. A call with an `X-LA2L-Client` header ends with it, cleaned and cut at 100 characters: which SDK and which version the app runs. The route is the pattern, never the real path, so pair ids and file names stay out of the log. The health check Docker itself runs every 30 seconds is not logged.

Between the requests are the events:

| Line | Means |
|---|---|
| `la2l-server 0.11.0 listening on ...` | The server started. |
| `state: 1 computer(s) and 2 app(s) paired, 0 package(s) waiting` | Right after the start: what the database holds. With `; test receivers: 3 with 4 app(s)` when there are test receivers, which are not counted as computers. |
| `pairing started: new computer` | Pair app in Live. `Add app for device 7`: Settings > Add app. `new test receiver`: a test receiver, such as the page `/la2l/receiver`. |
| `pairing claimed: app 8 on new device 7` | Someone typed the code. |
| `pairing delivered to device 7` | The device got its token: Live says "Paired with ...". |
| `package <id> created by app 8 for device 7: 3 sound(s), 4123456 bytes` | An app started a send. |
| `package <id> committed: 3 sound(s) wait for device 7` | All files are there; the next Import gets them. |
| `package <id> acked by device 7: imported` | Live has them (`partial`: some, `failed`: none). |
| `device 7 unpaired: 1 app(s) revoked, 0 package(s) deleted` | Unpair in Live. |
| `app 8 unpaired` | An app unpaired itself, for example Unpair this browser on the Sender page. |
| `app 8 removed by device 7: 1 package(s) deleted` | The computer removed one of its apps (`DELETE /api/apps/{id}`), with what that app still had waiting. |
| `cleanup: 2 expired package(s), 1 old result(s)` | The cleanup that runs every minute removed something. `test receiver(s) quiet for 7 days`: test receivers that made no call for 7 days, removed with their apps and packages. |
| `WARNING storage: packages take 8.2 GB of 10.0 GB (82%). ...` | The packages together passed `STORAGE_WARN_PERCENT` of `MAX_TOTAL_STORAGE_MB`. At most once an hour while it lasts. Above the limit itself new packages are refused: see who sends so much, and the disk. |
| `ERROR ...` | Something went wrong in the server. The line says what. |

Tokens, pair ids, codes, `Authorization` headers and request bodies are never logged. The addresses are, so the logs stay on the VPS.

### The storage warning by e-mail

`deploy/storage-mail.sh` mails the `WARNING storage` line through the sendmail of the VPS. The address is not in the repository: it is the first line of `~/.config/la2l/alert-email`.

```bash
mkdir -p ~/.config/la2l && chmod 700 ~/.config/la2l
echo "you@example.org" > ~/.config/la2l/alert-email
bash deploy/storage-mail.sh --test       # a test mail: check that it arrives, also in the spam folder
```

Then let cron look every 15 minutes (`crontab -e`, one line at the end):

```
*/15 * * * * bash $HOME/la2l-server/server/deploy/storage-mail.sh >> $HOME/la2l-server-logs/storage-mail.log 2>&1
```

`--dry-run` prints the mail it would send now, without sending it.

### Who is paired

```bash
docker exec -i la2l-server node - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/la2l.db', { readOnly: true });
console.table(db.prepare(`
  SELECT d.id AS computer, d.name, d.client, d.test, d.last_seen_at, a.id AS app, a.name AS app_name, a.client AS app_client, a.last_seen_at AS app_seen
  FROM devices d LEFT JOIN apps a ON a.device_ref = d.id AND a.revoked_at IS NULL
  WHERE d.revoked_at IS NULL ORDER BY d.id, a.id`).all());
console.table(db.prepare(`
  SELECT id, device_ref AS computer, status, item_count AS sounds, committed_at, expires_at
  FROM packages WHERE status IN ('waiting', 'failed') ORDER BY committed_at`).all());
JS
```

The first table lists the paired computers with their apps (`test` is 1 for a test receiver, `app_client` is the last `X-LA2L-Client` of the app), the second the packages that wait for Live. The database is opened read-only, so this changes nothing.

## Troubleshooting

| What you see | What to do |
|---|---|
| Self test in Live says `no App2Live server at lloydstellar.nl` | Something answers, but not la2l-server: nginx does not pass `/la2l/` on. `bash deploy/install-nginx.sh --check` shows what is missing. |
| Self test says `server answered 502` | nginx cannot reach the container: it is down. `docker compose ps`, then the next row. |
| `docker compose ps` says `restarting` or `unhealthy`, or shows no container | `docker compose logs --tail=50`: a wrong setting or a database from a newer server says so in its last lines. Fix that, then `bash deploy/update.sh`. |
| Self test says `server offline` or `server no answer` | The VPS or nginx does not answer at all: `systemctl status nginx`. |
| `/api/health` answers 503 `The server cannot store sounds right now.` | The data folder is not writable or the database does not answer: `docker compose logs --tail=50`. |
| Apps get `The server is full. Try again later.` | The packages together would pass `MAX_TOTAL_STORAGE_MB` (10 GB), or less than `MIN_FREE_DISK_MB` (2 GB) would be free on the disk after the upload. The log had `WARNING storage` lines before; [Who is paired](#who-is-paired) shows who has packages waiting. Free up disk space, or raise the limit in `.env` when the disk has room. |
| Apps get `Too many sounds wait for this computer. Click Import in Live first.` | With this package, more than 1 GB would wait for one computer (`MAX_DEVICE_STORAGE_MB`). Import in Live; packages also go 24 hours after their upload. |
| Apps get `Too many sounds wait from this address. Try again later.` | The packages sent from one address (an IPv6 address by its /64) would pass 2 GB (`MAX_ADDRESS_STORAGE_MB`), whichever computers they are for. It frees up as they are imported or expire, and a restart of the server forgets it. |
| An app gets 429 `Too many ...` | A rate limit (see [docs/server-api.md](../docs/server-api.md)). They live in memory; `docker compose restart` clears them. |
| Live says `This computer is no longer paired. Click Pair app to pair again.` | Its token is unknown to the server: it was unpaired, the computer paired again (that replaces the old pairing), or a backup from before the pairing was restored. Click Pair app. |
| The Sender page asks for a code again | Same reasons, for the app token: pair again. |
| Live keeps saying "Paired with LA2L Sender" after every app unpaired | Device 0.1.1 only learns about apps when it pairs; Unpair in Live clears it. Device 0.2.0 and newer ask `GET /api/apps` when Live starts, after Import and in Self test; 0.2.1 then shows Pair app again (0.2.0 says "No app paired. Add one in Settings."), and 0.2.2 also asks every 15 seconds while Import shows, so Pair app comes back by itself. |
| Import says `... did not download: The server does not know this address (404). The file is gone. Send it again.` (device 0.1.1 shows only the first sentence) | A file of a waiting package is missing on the server. The log has an `ERROR package ...` line about it. Send the package again. |

## Remove

```bash
sudo bash deploy/install-nginx.sh --remove    # takes /la2l/ out of nginx
docker compose down                           # removes the container; the volume and its data stay
docker volume rm la2l-server_la2l-data        # deletes every pairing and sound for good
```

## Where things are

| Path | |
|---|---|
| `src/main.js` | Start and stop, the request log, the cleanup timer. |
| `src/config.js` | The settings from the environment, with their checks. |
| `src/routes/device.js`, `src/routes/app.js`, `src/routes/packages.js` | The API: what the device calls, pairing for apps, and packages. |
| `src/db.js` | The database: schema, migrations, queries. |
| `src/cleanup.js` | What goes when: pairings, uploads, packages, results, revoked tokens, quiet test receivers. |
| `src/storage-watch.js` | The storage warning in the log. |
| `src/upload.js`, `src/wav-check.js`, `src/storage.js` | Uploads to disk with their checksum, the WAV check, the package folders. |
| `src/auth.js`, `src/tokens.js`, `src/ratelimit.js` | Tokens and codes, who is calling, rate limits. |
| `src/router.js`, `src/http-util.js`, `src/static.js` | Routes, JSON in and out, CORS, the Sender page files. |
| `public/` | LA2L Sender (`index.html`, `sender.js`, `big.js` for `?big`) and what makes it an installed app and a share target (`manifest.webmanifest`, the icons, `sw.js`, `share.js`, `zip.js`, and `share.html` for a share that reaches the server), the test receiver (`receiver.html`, `receiver.js`), the developer pages in `developers/` (made by `../tools/devpages.js`), and `vendor/`, built from `../sdk/js`: never edit `developers/` or `vendor/` by hand. The image also gets `../examples/web-drum-machine`, served under `/examples/drum-machine/`. |
| `test/` | The tests, with an end-to-end test that runs the real device code against this server. |
| `deploy/` | `update.sh`; `backup.sh` and `restore.sh`, with `copy-db.js` and `check-db.js`, which they run in a short-lived container of the server's image; and nginx: `nginx-la2l.conf` with `install-nginx.sh`. |

The server reuses the package and WAV checks of the device from `../src/node`, so both ends judge a package the same way. [CLAUDE.md](CLAUDE.md) has the rules for working on the code; [BUILD-PROMPT.md](BUILD-PROMPT.md) is the brief it was built from.
