import {Constants} from "../constants";
import {ipcRenderer, webFrame} from "electron";
import {fetchPost} from "../util/fetch";
import {adjustLayout, getInstanceById, JSONToCenter} from "../layout/util";
import {resizeTabs, setTabPosition} from "../layout/tabUtil";
import {initStatus} from "../layout/status";
import {appearanceConfigApi} from "../config/tabs/appearanceRuntime";
import {initAssets, setInlineStyle} from "../util/assets";
import {renderSnippet} from "../config/util/snippets";
import {getSearch} from "../util/functions";
import {initWindow} from "../boot/onGetConfig";
import {App} from "../index";
import {afterLayoutReady} from "../plugin/loader";
import {Tab} from "../layout/Tab";
import {initWindowOpenOverride} from "../protyle/util/compatibility";
/// #if !BROWSER
import {initNativeDialogOverride} from "../protyle/util/compatibility";
/// #endif
import {initWindowEvent} from "../boot/globalEvent/event";
import {getAllEditor} from "../layout/getAll";
import {registerAuthoringTransitionRenderer} from "../symemo/hostAuthoringTransition";
import {registerHostTabTransferRenderer, registerTabTransferDestination} from "../symemo/hostTabTransfer";


export const init = async (app: App) => {
    if (!await registerAuthoringTransitionRenderer()) {
        return;
    }
    registerHostTabTransferRenderer();
    webFrame.setZoomFactor(window.siyuan.storage[Constants.LOCAL_ZOOM]);
    const position = Constants.SIZE_ZOOM.find((item) => item.zoom === window.siyuan.storage[Constants.LOCAL_ZOOM]).position;
    ipcRenderer.send(Constants.SIYUAN_CMD, {
        cmd: "setTrafficLightPosition",
        zoom: window.siyuan.storage[Constants.LOCAL_ZOOM],
        position
    });
    initWindowEvent(app);
    fetchPost("/api/system/getEmojiConf", {}, response => {
        window.siyuan.emojis = response.data as IEmoji[];

        const transferId = getSearch("symemoTransferId");
        if (transferId) {
            void registerTabTransferDestination(transferId, (identity) => {
                JSONToCenter(app, {
                    direction: "lr",
                    resize: "lr",
                    size: "auto",
                    type: "center",
                    instance: "Layout",
                    children: [{
                        instance: "Wnd",
                        children: [{
                            instance: "Tab",
                            title: identity.title || window.siyuan.languages.untitled,
                            icon: identity.icon || "iconHelp",
                            pin: false,
                            active: true,
                            children: [identity],
                        }],
                    }],
                });
                window.siyuan.layout.centerLayout = window.siyuan.layout.layout;
                adjustLayout(window.siyuan.layout.centerLayout);
                afterLayout(app);
                setTimeout(() => {
                    setTabPosition();
                }, Constants.TIMEOUT_TRANSITION);
                return true;
            });
            return;
        }

        const layout = JSON.parse(sessionStorage.getItem("layout") || "{}");
        if (layout.layout) {
            JSONToCenter(app, layout.layout);
            window.siyuan.layout.centerLayout = window.siyuan.layout.layout;
        } else {
            const tabsJSON = JSON.parse(getSearch("json"));
            tabsJSON[tabsJSON.length - 1].active = true;
            JSONToCenter(app, {
                direction: "lr",
                resize: "lr",
                size: "auto",
                type: "center",
                instance: "Layout",
                children: [{
                    instance: "Wnd",
                    children: tabsJSON
                }]
            });
            window.siyuan.layout.centerLayout = window.siyuan.layout.layout;
            adjustLayout(window.siyuan.layout.centerLayout);
        }
        afterLayout(app);
        // 等待 dock 面板动画结束
        setTimeout(() => {
            setTabPosition();
        }, Constants.TIMEOUT_TRANSITION);
    });
    initStatus(true);
    initWindow(app);
    initWindowOpenOverride(app);
    /// #if !BROWSER
    initNativeDialogOverride();
    /// #endif
    appearanceConfigApi.apply(window.siyuan.config.appearance);
    initAssets();
    setInlineStyle();
    renderSnippet();
    let resizeTimeout = 0;
    window.addEventListener("resize", () => {
        window.clearTimeout(resizeTimeout);
        resizeTimeout = window.setTimeout(() => {
            adjustLayout(window.siyuan.layout.centerLayout);
            resizeTabs();
            window.siyuan.menus.menu.resetPosition();
            if (getSelection().rangeCount > 0) {
                const range = getSelection().getRangeAt(0);
                getAllEditor().forEach(item => {
                    if (item.protyle.wysiwyg.element.contains(range.startContainer)) {
                        item.protyle.toolbar.render(item.protyle, range);
                    }
                });
            }
            window.siyuan.dialogs.forEach(item => {
                item.resize();
            });
        }, Constants.TIMEOUT_RESIZE);
    });
};

const afterLayout = (app: App) => {
    afterLayoutReady(app);
    document.querySelectorAll('li[data-type="tab-header"][data-init-active="true"]').forEach((item: HTMLElement) => {
        const tab = getInstanceById(item.getAttribute("data-id")) as Tab;
        tab.parent.switchTab(item, false, false);
    });
};
