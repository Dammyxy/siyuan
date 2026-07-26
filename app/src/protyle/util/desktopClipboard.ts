export interface DesktopClipboardPayload {
    hasHTML: boolean;
    textHTML: string;
    textPlain: string;
}

export type DesktopClipboardInvoke = (
    channel: string,
    payload: {cmd: "clipboardAvailableFormats"} | {cmd: "clipboardRead"; format: string},
) => Promise<unknown>;

const readString = async (
    invoke: DesktopClipboardInvoke,
    channel: string,
    format: string,
): Promise<string> => {
    const value = await invoke(channel, {cmd: "clipboardRead", format});
    return typeof value === "string" ? value : "";
};

export const readDesktopClipboardPayload = async (
    invoke: DesktopClipboardInvoke,
    channel: string,
): Promise<DesktopClipboardPayload | undefined> => {
    try {
        const formats = await invoke(channel, {cmd: "clipboardAvailableFormats"});
        if (!Array.isArray(formats)) return undefined;
        const normalized = new Set(formats.map((format) =>
            typeof format === "string" ? format.toLowerCase() : ""));
        const hasHTML = normalized.has("text/html");
        const textHTML = hasHTML ? await readString(invoke, channel, "text/html") : "";
        const textPlain = normalized.has("text/plain")
            ? await readString(invoke, channel, "text/plain")
            : "";
        return hasHTML || textPlain.length > 0 ? {hasHTML, textHTML, textPlain} : undefined;
    } catch {
        return undefined;
    }
};
