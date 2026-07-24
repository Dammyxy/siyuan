import type {SymemoElementLayoutData} from "./types";

interface DockTabLike {type: string; show?: boolean; size?: {width: number; height: number}; [key: string]: unknown}
interface DockLike {data: DockTabLike[][]}
export interface DockLayoutLike {left: DockLike; right: DockLike; bottom: DockLike}

export const ensureSingleElementsDock = <T extends DockLayoutLike>(layout: T): T => {
    let first: DockTabLike | undefined;
    ([layout.left, layout.right, layout.bottom] as DockLike[]).forEach((dock) => {
        dock.data.forEach((group) => {
            for (let index = 0; index < group.length; index++) {
                if (group[index].type !== "elements") continue;
                if (!first) first = group[index];
                else {
                    group.splice(index, 1);
                    index--;
                }
            }
        });
    });
    if (!first) {
        const group = layout.left.data[0] || (layout.left.data[0] = []);
        const fileIndex = group.findIndex((item) => item.type === "file");
        group.splice(fileIndex < 0 ? group.length : fileIndex + 1, 0, {
            type: "elements", show: false, size: {width: 232, height: 0}, icon: "iconListTree", hotkeyLangId: "symemoElements",
        });
    }
    return layout;
};

const SAFE_ICONS = new Set(["iconLight", "iconFile", "iconRiffCard", "iconHelp"]);

export const normalizeSymemoLayoutData = (value: unknown): SymemoElementLayoutData | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.instance !== "SymemoElement" || typeof raw.elementId !== "string" || raw.elementId.trim().length === 0) return undefined;
    const result: SymemoElementLayoutData = {instance: "SymemoElement", elementId: raw.elementId};
    if (typeof raw.title === "string") result.title = raw.title;
    result.icon = typeof raw.icon === "string" && SAFE_ICONS.has(raw.icon) ? raw.icon : "iconHelp";
    return result;
};

export const serializeSymemoLayoutData = (value: {elementId: string; title?: string; icon?: string}): SymemoElementLayoutData => ({
    instance: "SymemoElement", elementId: value.elementId, title: value.title,
    icon: value.icon && SAFE_ICONS.has(value.icon) ? value.icon : "iconHelp",
});

export const getSymemoElementId = (value: {elementId?: unknown} | undefined, initData?: string): string | undefined => {
    if (typeof value?.elementId === "string" && value.elementId.trim().length > 0) return value.elementId;
    if (!initData) return undefined;
    try { return normalizeSymemoLayoutData(JSON.parse(initData))?.elementId; } catch (_) { return undefined; }
};
