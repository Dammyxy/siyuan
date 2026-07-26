const routeClipboardRequest = (clipboard, data) => {
    if (data?.cmd === "clipboardRead") {
        if (data.format === "text/plain") {
            return {handled: true, value: clipboard.readText()};
        }
        if (data.format === "text/html") {
            return {handled: true, value: clipboard.readHTML()};
        }
        return {handled: true, value: clipboard.read(data.format)};
    }
    if (data?.cmd === "clipboardAvailableFormats") {
        return {handled: true, value: clipboard.availableFormats()};
    }
    return {handled: false};
};

module.exports = {routeClipboardRequest};
