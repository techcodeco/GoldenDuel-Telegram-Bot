import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, basename, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Bot, InputFile } from "grammy";
import archiver from "archiver";
import type Redis from "ioredis";
import {
  BACKUP_COMMAND_CHANNEL,
  BACKUP_ENCRYPTION_PASSWORD,
  BACKUP_CONFIG_KEY,
  BACKUP_FAILURE_ACTIVE_KEY,
  BACKUP_HISTORY_KEY,
  BACKUP_HISTORY_LIMIT,
  BACKUP_INTERVAL_MINUTES,
  BACKUP_LOCK_TTL_SECONDS,
  BACKUP_OPLOG,
  BACKUP_TMP_DIR,
  BOT_TOKEN,
  MONGO_URI,
  MONGODUMP_BIN,
  MONITORING_NAMESPACE,
  OWNER_IDS,
  TELEGRAM_API_ROOT,
  TELEGRAM_UPLOAD_MAX_BYTES,
} from "./config";
import { logError, logger } from "./logger";
import type { BackupTelemetry } from "./telemetry";
import { buildMongodumpArgs } from "./dump-args";
import { encryptFile } from "./encryption";

const execFileAsync = promisify(execFile);
const bot = new Bot(BOT_TOKEN, { client: { apiRoot: TELEGRAM_API_ROOT } });
const lockNamespace = createHash("sha256")
  .update(MONITORING_NAMESPACE)
  .digest("hex")
  .slice(0, 12);
const lockKey = `gd:${lockNamespace}:ops:backup-worker:lock`;

export type BackupHistoryEntry = {
  id: string;
  createdAt: string;
  fileName: string;
  bytes: number;
  sha256: string;
  durationMs: number;
  collectionFiles: number;
  dumpFiles: number;
  oplogIncluded: boolean;
  telegramFileId: string;
  telegramMessageId: number;
  telegramChatId: number;
  telegramParts?: Array<{
    fileId: string;
    messageId: number;
    chatId: number;
    fileName: string;
    bytes: number;
  }>;
};

function sanitizeError(err: unknown): string {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, "[MongoDB URI redacted]")
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[Telegram token redacted]")
    .replace(/(BOT_TOKEN)[=: ]+[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

async function acquireLock(redis: Redis, token: string): Promise<boolean> {
  return (
    (await redis.set(lockKey, token, "EX", BACKUP_LOCK_TTL_SECONDS, "NX")) ===
    "OK"
  );
}

async function renewLock(redis: Redis, token: string): Promise<boolean> {
  const script =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
  return (
    Number(
      await redis.eval(script, 1, lockKey, token, BACKUP_LOCK_TTL_SECONDS),
    ) === 1
  );
}

async function releaseLock(redis: Redis, token: string): Promise<void> {
  const script =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redis.eval(script, 1, lockKey, token);
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", () => resolve(hash.digest("hex")));
  });
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

async function makeZip(
  dumpDirectory: string,
  outputZip: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputZip, { mode: 0o600 });
    const zip = archiver("zip", { zlib: { level: 1 } });
    output.once("close", resolve);
    output.once("error", reject);
    zip.once("warning", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") reject(error);
      else reject(error);
    });
    zip.once("error", reject);
    zip.pipe(output);
    // ZIP contains a regular mongodump directory: dump/<database>/<collection>.bson.gz,
    // metadata.json, and (if enabled) the oplog file. It is directly restorable by mongorestore.
    zip.directory(dumpDirectory, "dump");
    zip.append(`${JSON.stringify(manifest, null, 2)}\n`, {
      name: "manifest.json",
      mode: 0o600,
    });
    void zip.finalize().catch(reject);
  });
  await chmod(outputZip, 0o600);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index >= 3 ? 1 : 2)} ${units[index]}`;
}

function humanizeBackupFailure(message: string): string {
  const large = /^TELEGRAM_FILE_TOO_LARGE:(\d+):(\d+)$/.exec(message);
  if (large)
    return `حجم فایل بکاپ رمز‌شده (${formatBytes(Number(large[1]))}) از سقف بارگذاری فعلی تلگرام (${formatBytes(Number(large[2]))}) بیشتر است. فایل رمز‌شده روی دیسک موقت ساخته شد اما برای جلوگیری از باقی‌ماندن نسخهٔ موقت حذف می‌شود. برای فایل بزرگ‌تر، یک Telegram Bot API Server محلی تنظیم کنید یا محدودهٔ بکاپ را کوچک‌تر کنید.`;
  if (message.startsWith("TELEGRAM_DELIVERY_FAILED_FOR_ALL_OWNERS:"))
    return "ارسال فایل به هیچ‌یک از مالک‌ها موفق نبود. ابتدا شروع گفتگو با ربات توسط مالک، BOT_TOKEN، OWNER_IDS و دسترسی Bot API را بررسی کنید.";
  return message;
}

async function notifyFailureOnce(redis: Redis, message: string): Promise<void> {
  try {
    const claimed = await redis.set(
      BACKUP_FAILURE_ACTIVE_KEY,
      String(Date.now()),
      "NX",
    );
    if (claimed !== "OK") return;
  } catch (error) {
    logError("backup_failure_alert_lock_failed", error);
  }
  const text = `🚨 <b>خطا در بکاپ MongoDB</b>\n\n${htmlEscape(humanizeBackupFailure(message).slice(0, 900))}\n\nلطفاً پنل مدیریت بکاپ‌ها و لاگ‌های <code>backup-worker</code> را بررسی کنید.`;
  for (const ownerId of OWNER_IDS) {
    try {
      await bot.api.sendMessage(ownerId, text, { parse_mode: "HTML" });
    } catch (error) {
      logError("backup_failure_notify_owner_failed", error, { ownerId });
    }
  }
}

async function sendEncryptedBackupToOwners(
  backupPath: string,
  fileName: string,
  metadata: {
    createdAt: string;
    sha256: string;
    collectionFiles: number;
    dumpFiles: number;
    durationMs: number;
  },
): Promise<BackupHistoryEntry> {
  const info = await stat(backupPath);
  const partBytes = TELEGRAM_UPLOAD_MAX_BYTES;
  const partCount = Math.ceil(info.size / partBytes);
  const primaryParts: Array<{
    fileId: string;
    messageId: number;
    chatId: number;
    fileName: string;
    bytes: number;
  }> = [];
  const failedOwners: number[] = [];

  for (const ownerId of OWNER_IDS) {
    const deliveredParts: Array<{
      fileId: string;
      messageId: number;
      chatId: number;
      fileName: string;
      bytes: number;
    }> = [];
    try {
      for (let index = 0; index < partCount; index++) {
        const start = index * partBytes;
        const bytes = Math.min(partBytes, info.size - start);
        const end = start + bytes - 1;
        const partName =
          partCount === 1
            ? fileName
            : `${fileName}.part${String(index + 1).padStart(3, "0")}-of-${String(partCount).padStart(3, "0")}`;
        const partCaption =
          partCount === 1
            ? `🗄 <b>بکاپ رمزنگاری‌شده MongoDB</b>\n🕒 زمان: <code>${metadata.createdAt}</code>\n📦 حجم فایل رمز‌شده: <b>${formatBytes(info.size)}</b>\n🧩 فایل‌های کالکشن BSON: <b>${metadata.collectionFiles}</b>\n🔒 رمزنگاری: <b>AES-256-GCM</b>\n🔐 SHA-256 فایل کامل رمز‌شده: <code>${metadata.sha256}</code>\n🔑 برای بازیابی، رمز لازم است؛ پس از رمزگشایی، ZIP را استخراج و با mongorestore بازیابی کنید.`
            : `🗄 <b>بکاپ رمزنگاری‌شده چندبخشی MongoDB</b>\n🧩 بخش <b>${index + 1}/${partCount}</b> · حجم این بخش: <b>${formatBytes(bytes)}</b>\n🕒 زمان: <code>${metadata.createdAt}</code>\n📦 حجم کل فایل رمز‌شده: <b>${formatBytes(info.size)}</b>\n🔒 رمزنگاری: <b>AES-256-GCM</b>\n🔐 SHA-256 فایل کامل رمز‌شده: <code>${metadata.sha256}</code>\n⚠️ همه بخش‌ها را به ترتیب به یک فایل <code>.zip.enc</code> واحد متصل کن؛ سپس با کلید اصلی رمزگشایی کن.`;
        const message = await bot.api.sendDocument(
          ownerId,
          new InputFile(createReadStream(backupPath, { start, end }), partName),
          { caption: partCaption, parse_mode: "HTML" },
        );
        if (!message.document)
          throw new Error(
            `TELEGRAM_UPLOAD_RESPONSE_MISSING_DOCUMENT:part-${index + 1}`,
          );
        deliveredParts.push({
          fileId: message.document.file_id,
          messageId: message.message_id,
          chatId: message.chat.id,
          fileName: partName,
          bytes,
        });
        // SendDocument has per-chat rate limits; serialize multipart deliveries conservatively.
        if (partCount > 1 && index + 1 < partCount)
          await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      if (!primaryParts.length) primaryParts.push(...deliveredParts);
    } catch (error) {
      failedOwners.push(ownerId);
      logError("backup_telegram_delivery_failed", error, {
        ownerId,
        fileBytes: info.size,
        partCount,
        sentParts: deliveredParts.length,
      });
    }
  }

  if (!primaryParts.length)
    throw new Error(
      `TELEGRAM_DELIVERY_FAILED_FOR_ALL_OWNERS:${failedOwners.join(",") || "unknown"}`,
    );
  if (failedOwners.length)
    logger.warn(
      { failedOwners, partCount },
      "backup_delivered_to_some_owners_only",
    );

  const entry: BackupHistoryEntry = {
    id: `${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
    createdAt: metadata.createdAt,
    fileName,
    bytes: info.size,
    sha256: metadata.sha256,
    durationMs: metadata.durationMs,
    collectionFiles: metadata.collectionFiles,
    dumpFiles: metadata.dumpFiles,
    oplogIncluded: BACKUP_OPLOG,
    telegramFileId: primaryParts[0]!.fileId,
    telegramMessageId: primaryParts[0]!.messageId,
    telegramChatId: primaryParts[0]!.chatId,
    telegramParts: primaryParts,
  };
  return entry;
}

async function persistHistory(
  redis: Redis,
  entry: BackupHistoryEntry,
): Promise<void> {
  // Retry the metadata index so the owner dashboard can reliably page through the Telegram files.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await redis.lpush(BACKUP_HISTORY_KEY, JSON.stringify(entry));
      await redis.ltrim(BACKUP_HISTORY_KEY, 0, BACKUP_HISTORY_LIMIT - 1);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3)
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("BACKUP_HISTORY_PERSIST_FAILED");
}

export async function readBackupIntervalMinutes(redis: Redis): Promise<number> {
  try {
    const raw = await redis.get(BACKUP_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { intervalMinutes?: unknown };
      const value = Number(parsed.intervalMinutes);
      if (Number.isInteger(value) && value >= 1 && value <= 1440) return value;
      logger.warn(
        { key: "backup_interval_config_invalid" },
        "backup_interval_config_invalid",
      );
    }
  } catch (error) {
    logError("backup_interval_config_read_failed", error);
  }
  return BACKUP_INTERVAL_MINUTES;
}

export async function runBackup(
  redis: Redis,
  status: BackupTelemetry,
  onStatus: (next: Partial<BackupTelemetry>) => void,
): Promise<BackupHistoryEntry | undefined> {
  const token = randomUUID();
  const acquired = await acquireLock(redis, token);
  if (!acquired) {
    logger.warn({ key: "backup_lock_busy" }, "backup_lock_busy");
    return undefined;
  }

  let lockTimer: NodeJS.Timeout | undefined;
  let workDir = "";
  let success = false;
  const startedAt = new Date();
  const timerStart = Date.now();
  onStatus({
    backupStatus: "running",
    backupIntervalMinutes: await readBackupIntervalMinutes(redis),
    lastBackupError: undefined,
  });
  try {
    lockTimer = setInterval(
      () => {
        void renewLock(redis, token)
          .then((renewed) => {
            if (!renewed)
              logger.error({ key: "backup_lock_lost" }, "backup_lock_lost");
          })
          .catch((error) => logError("backup_lock_renew_failed", error));
      },
      Math.max(15_000, Math.floor((BACKUP_LOCK_TTL_SECONDS * 1000) / 3)),
    );
    lockTimer.unref();

    const tempRoot = BACKUP_TMP_DIR;
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    workDir = await mkdtemp(join(tempRoot, "gd-mongo-backup-"));
    await chmod(workDir, 0o700);
    const dumpDirectory = join(workDir, "dump");
    await mkdir(dumpDirectory, { recursive: true, mode: 0o700 });
    const zipPath = join(workDir, "gd-mongodb-backup.zip");
    const configPath = join(workDir, "mongodump-config.yml");
    const createdAt = startedAt.toISOString();
    const fileStamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const fileName = `gd-mongodb-${fileStamp}.zip.enc`;
    const encryptedPath = join(workDir, fileName);

    // Keep credentials out of the OS process list. Only mongodump can read this mode-0600 file.
    await writeFile(configPath, `uri: ${JSON.stringify(MONGO_URI)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(configPath, 0o600);

    logger.info(
      { createdAt, oplogIncluded: BACKUP_OPLOG, dumpMode: "BSON directory" },
      "backup_started",
    );
    const dumpArgs = buildMongodumpArgs(
      configPath,
      dumpDirectory,
      MONGO_URI,
      BACKUP_OPLOG,
    );
    await execFileAsync(MONGODUMP_BIN, dumpArgs, {
      timeout: 0,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    await rm(configPath, { force: true });

    const dumpFiles = await listFilesRecursively(dumpDirectory);
    const bsonFiles = dumpFiles.filter(
      (path) => path.endsWith(".bson") || path.endsWith(".bson.gz"),
    );
    if (!bsonFiles.length)
      throw new Error("MONGODUMP_CREATED_NO_BSON_COLLECTION_FILES");
    const dumpBytes = (
      await Promise.all(dumpFiles.map((path) => stat(path)))
    ).reduce((sum, item) => sum + item.size, 0);
    const manifest = {
      format: "gd-mongodb-bson-directory-v2",
      containerEncryption:
        "AES-256-GCM; outer file suffix .zip.enc; password is configured only through BACKUP_ENCRYPTION_PASSWORD",
      createdAt,
      archiveFormat:
        "mongodump --out=<directory> --gzip; each collection is BSON gzip plus metadata.json",
      dumpRoot: "dump/",
      dumpFiles: dumpFiles.length,
      collectionFiles: bsonFiles.length,
      dumpBytes,
      oplogIncluded: BACKUP_OPLOG,
      restore: `If Telegram split the backup into parts, concatenate them in order to reconstruct the full .zip.enc file; decrypt it using BACKUP_ENCRYPTION_PASSWORD, unzip the resulting ZIP, then run: mongorestore --uri=\"<MONGO_URI>\" --gzip ${BACKUP_OPLOG ? "--oplogReplay " : ""}--drop ./dump`,
      sourceService: "gd-backup-worker",
    };
    await makeZip(dumpDirectory, zipPath, manifest);
    // The plain ZIP stays local only. Encrypt it before sending any bytes to Telegram.
    await encryptFile(zipPath, encryptedPath, BACKUP_ENCRYPTION_PASSWORD);
    await rm(zipPath, { force: true });
    await rm(dumpDirectory, { recursive: true, force: true });
    const encryptedInfo = await stat(encryptedPath);
    const sha256 = await sha256File(encryptedPath);
    const durationMs = Date.now() - timerStart;
    const entry = await sendEncryptedBackupToOwners(encryptedPath, fileName, {
      createdAt,
      sha256,
      collectionFiles: bsonFiles.length,
      dumpFiles: dumpFiles.length,
      durationMs,
    });

    // A Telegram upload is the authoritative backup copy. Keep history metadata in Redis for pagination.
    try {
      await persistHistory(redis, entry);
    } catch (error) {
      logError("backup_history_index_failed_after_telegram_upload", error, {
        backupId: entry.id,
        telegramMessageId: entry.telegramMessageId,
      });
    }

    success = true;
    await redis
      .del(BACKUP_FAILURE_ACTIVE_KEY)
      .catch((error) => logError("backup_failure_state_clear_failed", error));
    onStatus({
      backupStatus: "success",
      lastBackupAt: createdAt,
      lastBackupId: entry.id,
      lastBackupFileName: fileName,
      lastBackupBytes: encryptedInfo.size,
      lastBackupSha256: sha256,
      lastBackupDurationMs: durationMs,
      lastBackupMessageId: entry.telegramMessageId,
      lastBackupFileId: entry.telegramFileId,
      lastBackupError: undefined,
    });
    logger.info(
      {
        backupId: entry.id,
        fileName,
        encryptedBytes: encryptedInfo.size,
        dumpBytes,
        dumpFiles: dumpFiles.length,
        collectionFiles: bsonFiles.length,
        sha256,
        durationMs,
        containerEncryption: "AES-256-GCM",
        oplogIncluded: BACKUP_OPLOG,
      },
      "encrypted_backup_uploaded_to_telegram",
    );
    return entry;
  } catch (error) {
    const message = sanitizeError(error);
    onStatus({ backupStatus: "error", lastBackupError: message });
    const safeError = new Error(message);
    if (error instanceof Error) safeError.name = error.name;
    logError("backup_cycle_failed", safeError, {
      elapsedMs: Date.now() - timerStart,
    });
    await notifyFailureOnce(redis, message).catch((notifyError) =>
      logError("backup_failure_notify_failed", notifyError),
    );
    return undefined;
  } finally {
    if (lockTimer) clearInterval(lockTimer);
    if (workDir)
      await rm(workDir, { recursive: true, force: true }).catch((error) =>
        logError("backup_temp_cleanup_failed", error),
      );
    await releaseLock(redis, token).catch((error) =>
      logError("backup_lock_release_failed", error),
    );
    if (!success)
      logger.warn(
        { status: status.backupStatus },
        "backup_cycle_finished_without_success",
      );
  }
}

export { BACKUP_COMMAND_CHANNEL };
