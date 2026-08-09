export interface ClipboardEnvironment {
  readonly secure: boolean;
  readonly writeText: ((text: string) => Promise<void>) | null;
  readonly legacyCopy: (text: string) => boolean;
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function browserClipboardEnvironment(): ClipboardEnvironment {
  return {
    secure: globalThis.isSecureContext,
    writeText: navigator.clipboard ? (text) => navigator.clipboard.writeText(text) : null,
    legacyCopy,
  };
}

export async function writeTextToClipboard(
  text: string,
  environment: ClipboardEnvironment = browserClipboardEnvironment(),
): Promise<void> {
  if (environment.secure && environment.writeText) {
    try {
      await environment.writeText(text);
      return;
    } catch {
      // Permission policies can still reject the modern API; the user gesture permits the legacy fallback.
    }
  }
  if (!environment.legacyCopy(text)) throw new Error("CLIPBOARD_COPY_FAILED");
}
