import "dotenv/config";
import { decryptFile } from "../encryption";

async function main(): Promise<void> {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length > 0) {
    throw new Error(
      "Usage: npm run decrypt-backup -- <backup.zip.enc> <output.zip>",
    );
  }
  const password = process.env.BACKUP_ENCRYPTION_PASSWORD;
  if (!password)
    throw new Error(
      "Set BACKUP_ENCRYPTION_PASSWORD in the environment or backup-worker/.env",
    );

  await decryptFile(inputPath, outputPath, password);
  console.log(`Backup decrypted successfully: ${outputPath}`);
}

main().catch(() => {
  console.error(
    "Backup decryption failed. Check the password, file integrity, paths, and write permissions.",
  );
  process.exitCode = 1;
});
