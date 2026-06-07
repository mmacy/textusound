import { idbGet, idbSet, idbDelete } from "./storage.js";

const HANDLE_KEY = "lastSaveHandle";
const PICKER_ID = "justsayit-save";

export function supportsFsAccess() {
  return typeof window.showSaveFilePicker === "function";
}

async function verifyPermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Save a blob locally. On Chromium, uses the File System Access API and
 * remembers the most-recently-used directory (via picker `id` + a persisted
 * handle passed as `startIn`) across saves and future visits. Elsewhere, falls
 * back to a normal download.
 *
 * @returns {Promise<{ok:boolean, method?:string, name?:string, cancelled?:boolean, degraded?:boolean, error?:string}>}
 */
export async function saveBlob(blob, suggestedName, mime, ext) {
  if (!supportsFsAccess()) {
    downloadBlob(blob, suggestedName);
    return { ok: true, method: "download", name: suggestedName };
  }

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

  let handle;
  try {
    let startIn;
    try {
      startIn = await idbGet(HANDLE_KEY);
    } catch {
      startIn = undefined;
    }
    try {
      handle = await window.showSaveFilePicker(
        startIn ? { ...baseOpts, startIn } : baseOpts,
      );
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, cancelled: true };
      // A stale/invalid persisted handle can make the picker throw; retry clean.
      if (startIn) {
        await idbDelete(HANDLE_KEY).catch(() => {});
        handle = await window.showSaveFilePicker(baseOpts);
      } else {
        throw e;
      }
    }

    if (!(await verifyPermission(handle))) {
      return {
        ok: false,
        error: "Permission to write to that location was denied.",
      };
    }

    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();

    try {
      await idbSet(HANDLE_KEY, handle);
    } catch {
      /* persisting the MRU handle is best-effort */
    }

    return { ok: true, method: "fs", name: handle.name };
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, cancelled: true };
    // Last resort so the user never loses their audio.
    downloadBlob(blob, suggestedName);
    return {
      ok: true,
      method: "download",
      name: suggestedName,
      degraded: true,
      error: String((e && e.message) || e),
    };
  }
}
