import { idbGet, idbSet, idbDelete } from "./storage.js";

const HANDLE_KEY = "lastSaveHandle";
const PICKER_ID = "textusound-save";

// The most-recently-used directory handle, kept in memory so the save picker
// can be opened synchronously from a click (without awaiting IndexedDB, which
// would consume the transient user activation required by showSaveFilePicker).
let mruHandle = null;
let mruPrimed = false;

export function supportsFsAccess() {
  return typeof window.showSaveFilePicker === "function";
}

export async function primeMru() {
  if (mruPrimed) return;
  mruPrimed = true;
  try {
    mruHandle = (await idbGet(HANDLE_KEY)) || null;
  } catch {
    mruHandle = null;
  }
}

async function verifyPermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

/**
 * Open the save picker. MUST be called synchronously within a user gesture
 * (no awaits before it on the call path) so transient activation is preserved.
 * Returns a FileSystemFileHandle, or throws (AbortError if the user cancelled).
 */
export async function pickSaveFile(suggestedName, mime, ext) {
  const baseOpts = {
    id: PICKER_ID,
    suggestedName,
    types: [
      {
        description: `${ext.toUpperCase()} audio`,
        accept: { [mime]: ["." + ext] },
      },
    ],
  };
  try {
    return await window.showSaveFilePicker(
      mruHandle ? { ...baseOpts, startIn: mruHandle } : baseOpts,
    );
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    // A stale/invalid persisted handle can make the picker throw; retry clean.
    if (mruHandle) {
      mruHandle = null;
      idbDelete(HANDLE_KEY).catch(() => {});
      return await window.showSaveFilePicker(baseOpts);
    }
    throw e;
  }
}

/** Write a blob to a handle from pickSaveFile and remember its directory. */
export async function writeToHandle(handle, blob) {
  if (!(await verifyPermission(handle))) {
    throw new DOMException(
      "Permission to write to that location was denied.",
      "NotAllowedError",
    );
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    try {
      await writable.abort();
    } catch {
      /* ignore */
    }
    throw e;
  }
  mruHandle = handle;
  idbSet(HANDLE_KEY, handle).catch(() => {});
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
