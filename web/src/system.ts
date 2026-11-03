// What this computer calls the things Studio mentions: the server says (Settings), and until
// Settings has loaded, the browser's own report stands in.
import type { System } from "./api";
import { S } from "./state";

const GUESS: System = /Mac/i.test(navigator.platform || navigator.userAgent)
  ? { os: "mac", keystore: "Keychain", files: "Finder", trash: "Trash" }
  : /Win/i.test(navigator.platform || navigator.userAgent)
    ? { os: "windows", keystore: "Credential Manager", files: "File Explorer", trash: "Recycle Bin" }
    : { os: "linux", keystore: "system keyring", files: "file manager", trash: "Trash" };

export const system = (): System => S.settings?.system ?? GUESS;

/** The modifier key for shortcuts, as its key cap reads. */
export const mod = () => (system().os === "mac" ? "⌘" : "Ctrl+");

/** The button that opens a folder in the system's file manager. */
export const showIn = () => ({ mac: "Show in Finder", windows: "Show in File Explorer", linux: "Open folder" })[system().os];

/** Where a stored key lives, short: a button, a table cell. */
export const keyPlace = () => ({ mac: "Keychain", windows: "Credential Manager", linux: "Keyring" })[system().os];

/** Where keys come from when they aren't stored by Studio. */
export const envPlace = () => (system().os === "windows" ? "Environment" : "Your shell");
