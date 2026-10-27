import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptFile, encryptFile } from "../src/encryption.ts";

const PASSWORD = "test-passphrase-that-is-long-enough-42";

test("encrypted backup round-trips with AES-GCM authentication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gd-encryption-test-"));
  const input = join(dir, "input.zip");
  const encrypted = join(dir, "input.zip.enc");
  const restored = join(dir, "restored.zip");
  const original = Buffer.from("test backup bytes\0\u2603\n".repeat(1000));
  try {
    await writeFile(input, original);
    await encryptFile(input, encrypted, PASSWORD);
    const encryptedBytes = await readFile(encrypted);
    assert.equal(encryptedBytes.subarray(0, 8).toString("ascii"), "RPSENC01");
    assert.notDeepEqual(encryptedBytes, original);
    assert.equal((await stat(encrypted)).mode & 0o777, 0o600);
    await decryptFile(encrypted, restored, PASSWORD);
    assert.deepEqual(await readFile(restored), original);
    assert.equal((await stat(restored)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrong password fails authentication and does not leave a restored file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gd-encryption-test-"));
  const input = join(dir, "input.zip");
  const encrypted = join(dir, "input.zip.enc");
  const restored = join(dir, "restored.zip");
  try {
    await writeFile(input, "secret backup content");
    await encryptFile(input, encrypted, PASSWORD);
    await assert.rejects(() =>
      decryptFile(encrypted, restored, "a-different-long-enough-password"),
    );
    await assert.rejects(() => stat(restored), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decryption never overwrites an existing destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gd-encryption-test-"));
  const input = join(dir, "input.zip");
  const encrypted = join(dir, "input.zip.enc");
  const restored = join(dir, "restored.zip");
  try {
    await writeFile(input, "secret backup content");
    await writeFile(restored, "do-not-overwrite");
    await encryptFile(input, encrypted, PASSWORD);
    await assert.rejects(() => decryptFile(encrypted, restored, PASSWORD), {
      code: "EEXIST",
    });
    assert.equal(await readFile(restored, "utf8"), "do-not-overwrite");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tampered encrypted bytes fail authentication and do not create output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gd-encryption-test-"));
  const input = join(dir, "input.zip");
  const encrypted = join(dir, "input.zip.enc");
  const restored = join(dir, "restored.zip");
  try {
    await writeFile(input, "secret backup content");
    await encryptFile(input, encrypted, PASSWORD);
    const bytes = await readFile(encrypted);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
    await writeFile(encrypted, bytes);
    await assert.rejects(() => decryptFile(encrypted, restored, PASSWORD));
    await assert.rejects(() => stat(restored), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
