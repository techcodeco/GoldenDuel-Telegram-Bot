# RPS Backup Worker — Telegram ZIP backups

`backup-worker` is a standalone service alongside the other RPS workers. It uses MongoDB Database Tools (`mongodump`) to create a normal BSON-directory dump with gzip-compressed collection files, packages the directory and `manifest.json` into a ZIP, and uploads the ZIP directly to the bot owners in Telegram. It does not use a second database or external object storage. A small Redis list stores only the backup index and Telegram `file_id` values for the management panel.

## Requirements

- Node.js 20+ and npm.
- `mongodump` from MongoDB Database Tools installed on `PATH` (or `MONGODUMP_BIN` set).
- The same bot `BOT_TOKEN`, numeric `OWNER_IDS`, `REDIS_URL`, and `MONITORING_NAMESPACE` as the other services.
- Each owner must open the bot in a private chat and press **Start** so Telegram allows the bot to send them documents.

## Setup

```bash
cd backup-worker
cp .env.example .env
# Fill MONGO_URI, BOT_TOKEN, OWNER_IDS and shared Redis/namespace settings
npm install
npm run typecheck
npm test
npm run build
npm start
```

The first backup starts when the worker comes up; subsequent runs use the interval configured by the owner in **Admin → Backup management**. The environment variable `BACKUP_INTERVAL_MINUTES` is only the initial fallback (default 15); owner changes are persisted in Redis and apply without restarting the worker. Valid interval is 1–1440 minutes. The manual “Run backup now” button publishes a command via Redis.

## ZIP format and Telegram size limits

The ZIP has this structure:

```text
gd-mongodb-<timestamp>.zip
├── manifest.json
└── dump/
    └── <database>/
        ├── <collection>.bson.gz
        └── <collection>.metadata.json.gz (where provided by mongodump)
```

Each collection remains a standard BSON dump produced by `mongodump --out=<directory> --gzip`. For ZIPs under the configured 47 MB default, the worker uploads one `.zip` document. Larger ZIPs are split into Telegram document parts under the cloud Bot API upload limit; the backup history retains each part's Telegram `file_id`. Download every numbered part and concatenate them in order to reconstruct the original ZIP before extracting it. The SHA-256 shown in Telegram and `manifest.json` is for the complete ZIP.

Telegram cloud Bot API has an upload limit of 50 MB for `sendDocument`; this worker leaves margin and uses 47 MB chunks by default. See the official Bot API documentation: https://core.telegram.org/bots/api. A large database therefore creates multiple Telegram documents for one logical backup, rather than silently skipping the backup.

## Management and monitoring

The private bot's owner menu contains **🗄 Backup management**. It shows:

- whether `backup-worker` has a fresh telemetry heartbeat;
- the configured interval, last successful backup timestamp, filename, size and last run/error;
- paginated history (five entries per page), with date, ZIP size, SHA-256 prefix and BSON-file count;
- a button to re-send/download all parts of a selected backup, a live interval input in minutes, and a manual-run command.

The private worker runs a Redis-leased watchdog. If the backup heartbeat goes stale, it alerts each owner and retries only failed deliveries; when a heartbeat returns, it sends recovery notices to owners who received the outage alert. Notification still requires the private worker, Redis and Telegram API to be alive, and each owner must have opened the bot in private. Run `backup-worker` under a process supervisor (e.g. systemd with `Restart=always`) too, because a bot cannot send an alert while the entire control plane or Telegram connectivity is down.

Pino logs go to `LOG_DIR`; daily/size-based rotation, retention and throttling are configured by `.env`. The worker reports `SERVER_NAME`, `INSTANCE_NAME`, hostname, PID, CPU/RAM/disk and current backup state to the same telemetry namespace used by the other services.

## Restore

1. Download the original `.zip` from Telegram. If it was split into numbered parts, download **all** parts and join them in numerical order first.
2. For split parts on Linux/macOS:

   ```bash
   cat gd-mongodb-<timestamp>.zip.part001-of-003 \
       gd-mongodb-<timestamp>.zip.part002-of-003 \
       gd-mongodb-<timestamp>.zip.part003-of-003 \
       > gd-mongodb-<timestamp>.zip
   unzip -t gd-mongodb-<timestamp>.zip
   unzip gd-mongodb-<timestamp>.zip -d restore-point
   ```

   Change `003` and the listed filenames to match the actual part count. On Windows `cmd.exe`, use binary concatenation: `copy /b part001+part002+part003 gd-mongodb-<timestamp>.zip`.

3. Inspect `restore-point/manifest.json` and confirm the target URI before restoring. Stop application workers first. Restore the BSON directory (not the outer ZIP) with:

   ```bash
   mongorestore --uri="$RESTORE_MONGO_URI" --gzip --drop restore-point/dump
   ```

   For a replica-set dump created with `BACKUP_OPLOG=true`, add `--oplogReplay` and ensure the URI meets MongoDB's oplog restore requirements. `--drop` is destructive for the destination collections represented in the backup. Test in a disposable staging database before restoring production. Protect connection strings and never paste them into chat or commit them to source control.

## Data consistency and oplog

Default `BACKUP_OPLOG=false` backs up the database path specified in `MONGO_URI`, with the normal caveat that concurrent writes may occur during the dump. `BACKUP_OPLOG=true` is only for a full replica-set dump: `MONGO_URI` must have no database path and must identify a replica set (or use `mongodb+srv://`); the MongoDB user needs privileges to dump the full deployment. The worker validates these settings before starting. Do not turn it on for a standalone instance or a sharded cluster without checking MongoDB's documented restore constraints.

## Configuration reference

- `MONGO_URI`: MongoDB source URI.
- `BOT_TOKEN`, `OWNER_IDS`: bot token and comma-separated numeric owner Telegram IDs.
- `REDIS_URL`, `MONITORING_NAMESPACE`: same shared Redis and namespace as other workers.
- `SERVER_NAME`: same physical-server name used by peer workers; `INSTANCE_NAME` should be unique.
- `BACKUP_INTERVAL_MINUTES`: initial interval fallback (1–1440, default 15); owner dashboard overrides are saved in Redis.
- `BACKUP_HISTORY_LIMIT`: number of metadata entries kept in Redis (10–5000; not the file data itself). Older backup documents are not automatically deleted from Telegram when Redis history is trimmed.
- `TELEGRAM_UPLOAD_MAX_MB`: upload part size ceiling in decimal MB (1–49; default 47).
- `BACKUP_OPLOG`, `MONGODUMP_BIN`, `BACKUP_TMP_DIR`, and `LOG_*`: tool, dump mode, temporary directory and logging options.
