import type {ElementTreeNodeView} from "./types";

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: UnknownRecord, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

const normalizeTreeTitle = (value: unknown): string =>
    typeof value === "string" && value.trim().length > 0 ? value : "";

const decodeTreeNode = (value: unknown, seenIds: Set<string>): ElementTreeNodeView | undefined => {
    if (!isRecord(value) || typeof value.elementId !== "string" || value.elementId.trim().length === 0 ||
        typeof value.type !== "string" || typeof value.sourceMode !== "string" ||
        typeof value.supportStatus !== "string") {
        return undefined;
    }
    if (seenIds.has(value.elementId)) {
        return undefined;
    }
    seenIds.add(value.elementId);

    let rawChildren: unknown[] = [];
    if (hasOwn(value, "children")) {
        if (!Array.isArray(value.children)) {
            return undefined;
        }
        rawChildren = value.children;
    }

    const children: ElementTreeNodeView[] = [];
    for (const child of rawChildren) {
        const decoded = decodeTreeNode(child, seenIds);
        if (!decoded) {
            return undefined;
        }
        children.push(decoded);
    }

    return {
        elementId: value.elementId,
        type: value.type,
        title: normalizeTreeTitle(value.title),
        sourceMode: value.sourceMode,
        supportStatus: value.supportStatus,
        children,
    };
};

export const decodeElementTreeData = (value: unknown): ElementTreeNodeView[] | undefined => {
    if (!isRecord(value) || !Array.isArray(value.nodes)) {
        return undefined;
    }
    const seenIds = new Set<string>();
    const nodes: ElementTreeNodeView[] = [];
    for (const node of value.nodes) {
        const decoded = decodeTreeNode(node, seenIds);
        if (!decoded) {
            return undefined;
        }
        nodes.push(decoded);
    }
    return nodes;
};

export const flattenElementTree = (nodes: ElementTreeNodeView[]): ElementTreeNodeView[] => {
    const flattened: ElementTreeNodeView[] = [];
    const visit = (items: ElementTreeNodeView[]) => {
        items.forEach((item) => {
            flattened.push(item);
            visit(item.children);
        });
    };
    visit(nodes);
    return flattened;
};

export const findElementNode = (nodes: ElementTreeNodeView[], elementId: string): ElementTreeNodeView | undefined => {
    for (const node of nodes) {
        if (node.elementId === elementId) {
            return node;
        }
        const child = findElementNode(node.children, elementId);
        if (child) {
            return child;
        }
    }
    return undefined;
};

export interface ElementRevealPlan {
    selectedElementId: string;
    expandedElementIds: string[];
}

export const getRevealPlan = (nodes: ElementTreeNodeView[], elementId: string): ElementRevealPlan | undefined => {
    const path: ElementTreeNodeView[] = [];
    const findPath = (items: ElementTreeNodeView[]): boolean => {
        for (const item of items) {
            path.push(item);
            if (item.elementId === elementId || findPath(item.children)) return true;
            path.pop();
        }
        return false;
    };
    if (!findPath(nodes)) return undefined;
    return {selectedElementId: elementId, expandedElementIds: path.slice(0, -1).map((item) => item.elementId)};
};

export const getElementDisplayTitle = (title: string, untitled: string): string =>
    title.trim().length > 0 ? title : untitled;

export const elementTypeIcon = (type: string): string => {
    switch (type) {
        case "concept":
            return "iconLight";
        case "topic":
            return "iconFile";
        case "item":
            return "iconRiffCard";
        default:
            return "iconHelp";
    }
};

export const parseStoredExpandedElementIds = (value: unknown): string[] => {
    let parsed = value;
    if (typeof value === "string") {
        try { parsed = JSON.parse(value); } catch (_) { return []; }
    }
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
};

export const normalizeExpandedElementIds = (nodes: ElementTreeNodeView[], stored: string[]): string[] => {
    const wanted = new Set(stored);
    return flattenElementTree(nodes).filter((node) => node.children.length > 0 && wanted.has(node.elementId)).map((node) => node.elementId);
};

export const shouldPersistExpandedElementIds = (previous: string[], next: string[]): boolean =>
    previous.length !== next.length || previous.some((value, index) => value !== next[index]);
