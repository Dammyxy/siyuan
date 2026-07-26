import type {
    TopicClipboardSnapshot,
    TopicPasteAvailability,
    TopicPasteCommand,
    TopicPasteFlavor,
} from "./types";

export const projectClipboardData = (data: Partial<IClipboardData> & {hasHTML?: boolean}): TopicClipboardSnapshot => ({
    textHTML: typeof data.textHTML === "string" ? data.textHTML : "",
    textPlain: typeof data.textPlain === "string" ? data.textPlain : "",
    hasHTML: data.hasHTML === true,
});

export const projectClipboardEvent = (event: ClipboardEvent): TopicClipboardSnapshot => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
        return {textHTML: "", textPlain: "", hasHTML: false};
    }
    const types = Array.from(clipboardData.types || []);
    const hasHTML = types.includes("text/html");
    return {
        textHTML: hasHTML ? clipboardData.getData("text/html") : "",
        textPlain: types.includes("text/plain") ? clipboardData.getData("text/plain") : "",
        hasHTML,
    };
};

export const getTopicPasteAvailability = (snapshot: TopicClipboardSnapshot): TopicPasteAvailability => ({
    paste: snapshot.hasHTML || snapshot.textPlain.length > 0,
    pasteAsPlainText: snapshot.textPlain.length > 0,
    pasteAsHTML: snapshot.hasHTML,
});

export const selectTopicPasteFlavor = (
    snapshot: TopicClipboardSnapshot,
    command: TopicPasteCommand,
): TopicPasteFlavor => {
    if (command === "paste") {
        if (snapshot.hasHTML) {
            return {kind: "html", html: snapshot.textHTML};
        }
        return snapshot.textPlain ? {kind: "markdown", markdown: snapshot.textPlain} : {kind: "none"};
    }
    if (command === "pasteAsPlainText") {
        return snapshot.textPlain ? {kind: "plainText", text: snapshot.textPlain} : {kind: "none"};
    }
    return snapshot.hasHTML ? {kind: "html", html: snapshot.textHTML} : {kind: "none"};
};
