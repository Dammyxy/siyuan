import type {App} from "../index";
import {Dialog} from "../dialog";
import {createItem} from "./api";
import {runWindowAuthoringOperation} from "./authoringRegistry";
import {openElement, prepareNativeElementOpen} from "./openElement";

export interface ItemCreateDialogOptions {
    app: App;
    refreshTree(): Promise<void>;
}

interface RetainedCreateIntent {
    elementId: string;
    prompt: string;
    answer: string;
}

let activeDialog: Dialog | undefined;

const itemTitle = (prompt: string): string => {
    const line = prompt.split(/\r\n|\r|\n/).map((value) => value.trim()).find(Boolean) || "";
    return Array.from(line).slice(0, 512).join("");
};

export const openItemCreateDialog = (options: ItemCreateDialogOptions): Dialog => {
    if (activeDialog && activeDialog.element.ownerDocument !== document) {
        activeDialog = undefined;
    }
    if (activeDialog) {
        return activeDialog;
    }

    let disposed = false;
    let submitting = false;
    let retainedIntent: RetainedCreateIntent | undefined;
    const languages = window.siyuan.languages;
    const dialog = new Dialog({
        title: languages.symemoNewItem,
        content: `<div class="b3-dialog__content symemo-item-create">
    <label class="b3-label">${languages.symemoQuestion}</label>
    <textarea class="b3-text-field fn__block" data-role="prompt"></textarea>
    <label class="b3-label">${languages.symemoAnswer}</label>
    <textarea class="b3-text-field fn__block" data-role="answer"></textarea>
    <div class="ft__on-surface" data-role="status"></div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel" data-role="cancel">${languages.cancel}</button><div class="fn__space"></div>
    <button class="b3-button b3-button--text" data-role="confirm">${languages.symemoCreateItem}</button>
</div>`,
        width: "560px",
        destroyCallback: () => {
            disposed = true;
            if (activeDialog === dialog) {
                activeDialog = undefined;
            }
        },
    });
    activeDialog = dialog;

    const promptElement = dialog.element.querySelector('[data-role="prompt"]') as HTMLTextAreaElement;
    const answerElement = dialog.element.querySelector('[data-role="answer"]') as HTMLTextAreaElement;
    const statusElement = dialog.element.querySelector('[data-role="status"]') as HTMLElement;
    const cancelElement = dialog.element.querySelector('[data-role="cancel"]') as HTMLButtonElement;
    const confirmElement = dialog.element.querySelector('[data-role="confirm"]') as HTMLButtonElement;

    const setFieldsDisabled = (disabled: boolean): void => {
        if (disabled) {
            promptElement.setAttribute("disabled", "disabled");
            answerElement.setAttribute("disabled", "disabled");
        } else {
            promptElement.removeAttribute("disabled");
            answerElement.removeAttribute("disabled");
        }
    };

    dialog.bindInput(promptElement, undefined, false);
    dialog.bindInput(answerElement, undefined, false);
    cancelElement.addEventListener("click", () => dialog.destroy());
    confirmElement.addEventListener("click", () => {
        if (submitting || disposed || !dialog.element.isConnected || confirmElement.getAttribute("disabled") !== null) {
            return;
        }
        if (!retainedIntent && promptElement.value.trim().length === 0) {
            statusElement.textContent = languages.symemoItemPromptRequired;
            promptElement.focus();
            return;
        }
        if (!retainedIntent && answerElement.value.trim().length === 0) {
            statusElement.textContent = languages.symemoItemAnswerRequired;
            answerElement.focus();
            return;
        }
        submitting = true;
        void runWindowAuthoringOperation("create-item", async (operation) => {
            try {
                const preparation = await prepareNativeElementOpen("ordinary");
                if (!preparation.allowed || operation.isCancelled || disposed || !dialog.element.isConnected) {
                    return;
                }
                retainedIntent ||= {
                    elementId: Lute.NewNodeID(),
                    prompt: promptElement.value,
                    answer: answerElement.value,
                };
                statusElement.textContent = languages.symemoCreatingItem;
                const result = await createItem(retainedIntent.elementId, retainedIntent.prompt, retainedIntent.answer);
                if (operation.isCancelled || disposed || !dialog.element.isConnected) {
                    return;
                }
                if (result.ok === false) {
                    if (result.failure.acceptance === "unknown") {
                        setFieldsDisabled(true);
                    } else if (result.failure.acceptance === "notAccepted") {
                        retainedIntent = undefined;
                    } else {
                        setFieldsDisabled(true);
                        confirmElement.setAttribute("disabled", "disabled");
                    }
                    statusElement.textContent = result.failure.acceptance === "accepted"
                        ? languages.symemoItemCreateAcceptedRecovering
                        : languages.symemoItemCreateFailed;
                    return;
                }
                await options.refreshTree();
                if (operation.isCancelled || disposed || !dialog.element.isConnected) {
                    return;
                }
                await openElement({
                    app: options.app,
                    elementId: retainedIntent.elementId,
                    title: itemTitle(retainedIntent.prompt),
                    type: "item",
                    intent: "ordinary",
                    source: "other",
                }, preparation);
                if (!operation.isCancelled && !disposed && dialog.element.isConnected) {
                    dialog.destroy();
                }
            } finally {
                submitting = false;
            }
        });
    });
    promptElement.focus();
    return dialog;
};
