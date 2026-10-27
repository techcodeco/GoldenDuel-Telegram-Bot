import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { appendFile, chmod, link, open, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

const MAGIC = Buffer.from('RPSENC01', 'ascii')
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.trim().length < 16) {
    throw new Error('BACKUP_ENCRYPTION_PASSWORD_MUST_BE_AT_LEAST_16_CHARACTERS')
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error)
      else resolveKey(key)
    })
  })
}

/** Encrypts a file into the versioned RPSENC01 container without buffering the file in memory.
 * Format: magic(8) | salt(16) | IV(12) | ciphertext(N) | GCM tag(16).
 */
export async function encryptFile(inputPath: string, outputPath: string, password: string): Promise<void> {
  validatePassword(password)
  if (resolve(inputPath) === resolve(outputPath)) throw new Error('ENCRYPT_INPUT_AND_OUTPUT_MUST_DIFFER')

  const inputStat = await stat(inputPath)
  if (!inputStat.isFile()) throw new Error('ENCRYPT_INPUT_MUST_BE_A_FILE')

  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  let outputCreated = false

  try {
    const header = Buffer.concat([MAGIC, salt, iv])
    await writeFile(outputPath, header, { mode: 0o600, flag: 'wx' })
    outputCreated = true
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(outputPath, { flags: 'a', mode: 0o600 }),
    )
    await appendFile(outputPath, cipher.getAuthTag())
    await chmod(outputPath, 0o600)
  } catch (error) {
    if (outputCreated) await rm(outputPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    key.fill(0)
  }
}

/** Decrypts a RPSENC01 container, writing output only after GCM authentication succeeds.
 * The destination must not already exist; this prevents accidental overwrites during restore.
 */
export async function decryptFile(inputPath: string, outputPath: string, password: string): Promise<void> {
  validatePassword(password)
  if (resolve(inputPath) === resolve(outputPath)) throw new Error('DECRYPT_INPUT_AND_OUTPUT_MUST_DIFFER')

  const encrypted = await open(inputPath, 'r')
  let fileSize = 0
  let salt: Buffer
  let iv: Buffer
  let tag: Buffer
  try {
    const fileStat = await encrypted.stat()
    fileSize = fileStat.size
    if (!fileStat.isFile() || fileSize < HEADER_LENGTH + TAG_LENGTH) {
      throw new Error('ENCRYPTED_BACKUP_FILE_IS_TOO_SHORT')
    }

    const header = Buffer.alloc(HEADER_LENGTH)
    const headerResult = await encrypted.read(header, 0, HEADER_LENGTH, 0)
    if (headerResult.bytesRead !== HEADER_LENGTH || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('UNSUPPORTED_OR_INVALID_ENCRYPTED_BACKUP_FORMAT')
    }
    salt = Buffer.from(header.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH))
    iv = Buffer.from(header.subarray(MAGIC.length + SALT_LENGTH, HEADER_LENGTH))

    tag = Buffer.alloc(TAG_LENGTH)
    const tagResult = await encrypted.read(tag, 0, TAG_LENGTH, fileSize - TAG_LENGTH)
    if (tagResult.bytesRead !== TAG_LENGTH) throw new Error('ENCRYPTED_BACKUP_AUTH_TAG_MISSING')
  } finally {
    await encrypted.close()
  }

  const key = await deriveKey(password, salt!)
  const decipher = createDecipheriv('aes-256-gcm', key, iv!)
  decipher.setAuthTag(tag!)
  const outputDirectory = dirname(resolve(outputPath))
  const temporaryPath = join(outputDirectory, `.${basename(outputPath)}.${randomBytes(8).toString('hex')}.partial`)
  let temporaryCreated = false

  try {
    const temporaryHandle = await open(temporaryPath, 'wx', 0o600)
    temporaryCreated = true
    const ciphertextBytes = fileSize - HEADER_LENGTH - TAG_LENGTH
    const encryptedSource = ciphertextBytes === 0
      ? Readable.from([])
      : createReadStream(inputPath, { start: HEADER_LENGTH, end: fileSize - TAG_LENGTH - 1 })
    await pipeline(encryptedSource, decipher, temporaryHandle.createWriteStream())
    await chmod(temporaryPath, 0o600)
    // link() fails with EEXIST rather than silently replacing an existing restore file.
    await link(temporaryPath, outputPath)
    await unlink(temporaryPath)
    temporaryCreated = false
  } catch (error) {
    if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    key.fill(0)
  }
}
