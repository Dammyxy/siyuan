type Listener = (event: Event) => void;

export class TestClassList {
    private readonly values = new Set<string>();
    public mutationCount = 0;

    public add(...tokens: string[]) {
        tokens.forEach((token) => {
            if (token && !this.values.has(token)) {
                this.values.add(token);
                this.mutationCount++;
            }
        });
    }

    public remove(...tokens: string[]) {
        tokens.forEach((token) => {
            if (this.values.delete(token)) this.mutationCount++;
        });
    }

    public contains(token: string) {
        return this.values.has(token);
    }

    public toggle(token: string, force?: boolean) {
        const shouldAdd = force ?? !this.values.has(token);
        if (shouldAdd) this.add(token);
        else this.remove(token);
        return shouldAdd;
    }

    public replaceFrom(value: string) {
        this.values.clear();
        value.split(/\s+/).forEach((token) => this.add(token));
    }

    public toString() {
        return [...this.values].join(" ");
    }
}

const matchesToken = (element: TestElement, token: string): boolean => {
    const tag = token.match(/^[a-zA-Z][\w-]*/)?.[0];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    for (const className of token.matchAll(/\.([\w-]+)/g)) {
        if (!element.classList.contains(className[1])) return false;
    }
    for (const attribute of token.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        const actual = element.getAttribute(attribute[1]);
        if (actual === null || (attribute[2] !== undefined && actual !== attribute[2])) return false;
    }
    return true;
};

export class TestElement {
    public readonly classList = new TestClassList();
    public readonly children: TestElement[] = [];
    public readonly style: Record<string, string> = {};
    public parentElement: TestElement | null = null;
    public isConnected = true;
    public textContent = "";
    public title = "";
    public value = "";
    public scrollTop = 0;
    public innerHTMLAssignments = 0;
    public scrolled = false;
    public focused = false;
    private html = "";
    private readonly attributes = new Map<string, string>();
    private readonly listeners = new Map<string, Listener[]>();
    private innerHTMLBuilder?: (element: TestElement, html: string) => void;

    constructor(
        public readonly ownerDocument: TestDocument,
        public readonly tagName = "DIV",
        public readonly namespaceURI = "http://www.w3.org/1999/xhtml",
    ) {}

    public get className() {
        return this.classList.toString();
    }

    public set className(value: string) {
        this.classList.replaceFrom(value);
    }

    public get innerHTML() {
        return this.html;
    }

    public set innerHTML(value: string) {
        this.innerHTMLAssignments++;
        this.html = value;
        this.replaceChildren();
        this.innerHTMLBuilder?.(this, value);
    }

    public get firstElementChild() {
        return this.children[0] || null;
    }

    public setInnerHTMLBuilder(builder: (element: TestElement, html: string) => void) {
        this.innerHTMLBuilder = builder;
    }

    public setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }

    public setAttributeNS(_namespaceURI: string | null, qualifiedName: string, value: string) {
        this.setAttribute(qualifiedName, value);
    }

    public getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
    }

    public removeAttribute(name: string) {
        this.attributes.delete(name);
    }

    public append(...nodes: TestElement[]) {
        nodes.forEach((node) => {
            node.parentElement = this;
            node.isConnected = this.isConnected;
            this.children.push(node);
        });
    }

    public prepend(...nodes: TestElement[]) {
        [...nodes].reverse().forEach((node) => {
            node.parentElement = this;
            node.isConnected = this.isConnected;
            this.children.unshift(node);
        });
    }

    public replaceChildren(...nodes: TestElement[]) {
        this.children.forEach((node) => {
            node.parentElement = null;
            node.isConnected = false;
        });
        this.children.length = 0;
        this.append(...nodes);
    }

    public remove() {
        if (this.parentElement) {
            const index = this.parentElement.children.indexOf(this);
            if (index >= 0) this.parentElement.children.splice(index, 1);
        }
        this.parentElement = null;
        this.isConnected = false;
    }

    public addEventListener(type: string, listener: Listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    public dispatch(type: string, init: Record<string, unknown> = {}) {
        const event = {type, target: this, ...init} as unknown as Event;
        this.listeners.get(type)?.forEach((listener) => listener(event));
    }

    public querySelector(selector: string): TestElement | null {
        return this.querySelectorAll(selector)[0] || null;
    }

    public querySelectorAll(selector: string): TestElement[] {
        const tokens = selector.trim().split(/\s+/);
        let candidates = [...this.descendants()];
        if (tokens.length === 1) return candidates.filter((element) => matchesToken(element, tokens[0]));

        const last = tokens[tokens.length - 1];
        candidates = candidates.filter((element) => matchesToken(element, last));
        return candidates.filter((element) => {
            let ancestor = element.parentElement;
            for (let index = tokens.length - 2; index >= 0; index--) {
                while (ancestor && !matchesToken(ancestor, tokens[index])) ancestor = ancestor.parentElement;
                if (!ancestor) return false;
                ancestor = ancestor.parentElement;
            }
            return true;
        });
    }

    public closest(selector: string): TestElement | null {
        if (matchesToken(this, selector)) return this;
        let element = this.parentElement;
        while (element) {
            if (matchesToken(element, selector)) return element;
            element = element.parentElement;
        }
        return null;
    }

    public scrollIntoView() {
        this.scrolled = true;
    }

    public focus() {
        this.focused = true;
    }

    public getBoundingClientRect() {
        return {bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON() { return {}; }};
    }

    private *descendants(): Generator<TestElement> {
        for (const child of this.children) {
            yield child;
            yield* child.descendants();
        }
    }
}

export class TestDocument {
    public createElement(tagName: string) {
        return new TestElement(this, tagName.toUpperCase());
    }

    public createElementNS(namespaceURI: string, qualifiedName: string) {
        return new TestElement(this, qualifiedName.toUpperCase(), namespaceURI);
    }
}

const appendIcon = (document: TestDocument, header: TestElement, type: string) => {
    const button = document.createElement("span");
    button.setAttribute("data-type", type);
    const svg = document.createElement("svg");
    button.append(svg);
    header.append(button);
};

export const createElementsPanel = (document: TestDocument) => {
    const panel = document.createElement("div");
    panel.setInnerHTMLBuilder((element, html) => {
        if (!html.includes("symemo-elements__body")) return;
        const header = document.createElement("div");
        header.className = "block__icons";
        const logo = document.createElement("div");
        logo.className = "block__logo fn__flex-1";
        logo.append(document.createElement("svg"), document.createElement("span"));
        header.append(logo);
        appendIcon(document, header, "refresh");
        appendIcon(document, header, "collapse");
        appendIcon(document, header, "min");
        const body = document.createElement("div");
        body.className = "symemo-elements__body fn__flex-1";
        element.append(header, body);
    });
    return panel;
};

export const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return {promise, resolve};
};
