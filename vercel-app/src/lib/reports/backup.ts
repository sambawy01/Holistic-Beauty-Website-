import { del, get, list, put } from "@vercel/blob";

/**
 * Weekly business backup (/api/cron/backup, Monday 03:00 Cairo).
 *
 * Exports EVERY business blob into one JSON snapshot:
 * - orders/*                  (one JSON doc per order)
 * - crm/clients/*             (per-client tag overlays + per-note blobs — PII:
 *                              private notes, tags, visit-derived ids)
 * - catalog/products.json     (shop catalog)
 * - catalog/treatments.json   (treatments catalog)
 * - telegram/audit.jsonl      (Vassili's append-only action log)
 *
 * PII NOTE: the CRM blobs hold private client notes/tags. The snapshot is only
 * ever written to the private Blob store and emailed to the OWNER address
 * (NOTIFY_EMAIL) — keep it owner-only; never widen the recipient set.
 *
 * BYTE-RESTORE DISCIPLINE: each file is captured as its RAW TEXT (`text`),
 * not re-parsed/re-serialized JSON — a restore is exactly
 * `put(file.pathname, file.text)` and reproduces the original bytes (all
 * stores are UTF-8 text). The snapshot never mutates source blobs; it only
 * ever WRITES under backups/.
 *
 * NOT A POINT-IN-TIME SNAPSHOT: blobs are read one by one over several
 * seconds with no store-wide transaction (Blob has none). Writes that land
 * mid-snapshot can make the capture a mix of before/after states ACROSS
 * files (e.g. an order blob from 03:00:01 next to a catalog from 03:00:04).
 * Each individual file is still internally consistent, and every store here
 * is an independent document, so per-file restores are always safe — just
 * never treat one snapshot as a transactionally consistent whole.
 *
 * Retention: backups/YYYY-MM-DD.json (Cairo date), newest BACKUP_KEEP kept,
 * older deleted. Re-running on the same day overwrites that day's snapshot.
 *
 * Size: the whole business state is a few hundred KB — far under Resend's
 * ~40MB attachment cap, so the snapshot is also emailed as a .json
 * attachment for an off-Blob copy.
 */

export const BACKUP_PREFIX = "backups/";
export const BACKUP_KEEP = 8;

const SINGLE_FILES = [
  "catalog/products.json",
  "catalog/treatments.json",
  "telegram/audit.jsonl",
] as const;

const ORDERS_PREFIX = "orders/";
/** CRM overlays + per-note blobs (private PII). */
const CRM_PREFIX = "crm/clients/";
/** Prefixes captured one-blob-per-doc (each may span up to the list limit). */
const BLOB_PREFIXES = [ORDERS_PREFIX, CRM_PREFIX] as const;
/** Generous cap — order + CRM volume is small for a single studio. */
const ORDERS_LIST_LIMIT = 1000;

export interface BackupFile {
  pathname: string;
  /** Raw blob text, byte-faithful for restore. */
  text: string;
}

export interface BackupSnapshot {
  version: 1;
  generatedAt: string;
  /**
   * True when the orders listing hit ORDERS_LIST_LIMIT with more blobs
   * remaining — the snapshot is then INCOMPLETE (orders beyond the limit
   * are absent, not "missing"). Alarm-worthy: the cap assumes a small shop.
   */
  truncated: boolean;
  /** Blobs that were listed/expected but unreadable at snapshot time. */
  missing: string[];
  files: BackupFile[];
}

async function readBlobText(pathname: string): Promise<string | null> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  return await new Response(result.stream).text();
}

/** Read all business blobs into one snapshot. Throws only if LISTING fails. */
export async function buildBackupSnapshot(
  now: Date = new Date()
): Promise<BackupSnapshot> {
  const files: BackupFile[] = [];
  const missing: string[] = [];

  // List each one-blob-per-doc prefix (orders + CRM). A prefix that hit the
  // page cap with more remaining marks the snapshot INCOMPLETE (truncated).
  const listed: string[] = [];
  let truncated = false;
  for (const prefix of BLOB_PREFIXES) {
    const { blobs, hasMore } = await list({ prefix, limit: ORDERS_LIST_LIMIT });
    listed.push(...blobs.map((b) => b.pathname));
    if (hasMore) {
      truncated = true;
      console.error(
        `[backup] ${prefix} listing truncated at ${ORDERS_LIST_LIMIT} — snapshot is INCOMPLETE`
      );
    }
  }
  const pathnames = [...listed, ...SINGLE_FILES];

  for (const pathname of pathnames) {
    try {
      const text = await readBlobText(pathname);
      if (text === null) {
        // SINGLE_FILES may legitimately not exist yet (lazy first write) —
        // recorded, not fatal.
        missing.push(pathname);
      } else {
        files.push({ pathname, text });
      }
    } catch (error) {
      console.error(`[backup] Failed to read ${pathname}:`, error);
      missing.push(pathname);
    }
  }

  return {
    version: 1,
    generatedAt: now.toISOString(),
    truncated,
    missing,
    files,
  };
}

export function backupPathname(cairoDateKey: string): string {
  return `${BACKUP_PREFIX}${cairoDateKey}.json`;
}

/** Write the snapshot to backups/YYYY-MM-DD.json (same-day rerun overwrites). */
export async function writeBackup(
  snapshot: BackupSnapshot,
  dateKey: string
): Promise<{ pathname: string; json: string }> {
  const pathname = backupPathname(dateKey);
  const json = JSON.stringify(snapshot, null, 2);
  await put(pathname, json, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return { pathname, json };
}

const BACKUP_NAME_RE = /^backups\/\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Pure rotation rule: among well-formed backups/YYYY-MM-DD.json pathnames,
 * keep the newest `keep` (ISO dates sort lexicographically) and return the
 * rest for deletion. Pathnames that don't match the naming scheme are NEVER
 * returned — rotation can only ever delete files this job itself wrote.
 */
export function selectBackupsToDelete(
  pathnames: string[],
  keep: number = BACKUP_KEEP
): string[] {
  return pathnames
    .filter((p) => BACKUP_NAME_RE.test(p))
    .sort()
    .reverse()
    .slice(keep);
}

/** Apply retention: delete everything beyond the newest BACKUP_KEEP. */
export async function rotateBackups(): Promise<{ deleted: string[] }> {
  const { blobs } = await list({ prefix: BACKUP_PREFIX, limit: 1000 });
  const toDelete = selectBackupsToDelete(blobs.map((b) => b.pathname));
  for (const pathname of toDelete) {
    await del(pathname);
  }
  return { deleted: toDelete };
}
