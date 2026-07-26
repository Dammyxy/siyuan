import type {App} from "../index";
import {Constants} from "../constants";
import {ipcRenderer} from "electron";
import {beginWindowElementAuthoringTransition, createTransitionToken} from "../symemo/authoringRegistry";

let closePromise: Promise<boolean> | undefined;

const performClose = async (app: App, requestId: string): Promise<boolean> => {
    const lease = await beginWindowElementAuthoringTransition("window-close", requestId);
    if (lease.allowed === false) {
        return false;
    }
    lease.commit();
    for (let i = 0; i < app.plugins.length; i++) {
        const plugin = app.plugins[i];
        try {
            await plugin.onunload();
        } catch (e) {
            console.error(e);
        }
        try {
            await plugin.kernel?.destroy();
        } catch (e) {
            console.error(e);
        }
    }
    ipcRenderer.send(Constants.SIYUAN_CMD, "destroy");
    return true;
};

export const closeWindow = (app: App): Promise<boolean> => {
    if (closePromise) {
        return closePromise;
    }
    closePromise = performClose(app, `window-close:${createTransitionToken()}`);
    void closePromise.then((closed) => {
        if (!closed) {
            closePromise = undefined;
        }
    });
    return closePromise;
};
