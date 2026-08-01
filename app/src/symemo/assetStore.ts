
export interface AssetSelectionBookmark {
    [key: string]: unknown;
}

export interface AssetImportSuccess {
    ok: true;
    references: string[];
    selection: AssetSelectionBookmark;
}

export type AssetImportFailureKind = "request" | "response" | "validation";

export interface AssetImportFailure {
    ok: false;
    kind: AssetImportFailureKind;
    selection: AssetSelectionBookmark;
    rejectedFiles?: string[];
}

export type AssetImportResult = AssetImportSuccess | AssetImportFailure;

export interface NativeUploadResponse {
    code?: unknown;
    msg?: unknown;
    data?: {
        succMap?: unknown;
        errFiles?: unknown;
    };
}

export type AssetUploadTransport = (formData: FormData) => Promise<NativeUploadResponse>;

export interface AssetImportOptions {
    maxBytes?: number;
}

const DEFAULT_NATIVE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024 * 1024;
const ASSET_REFERENCE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const defaultTransport: AssetUploadTransport = async (formData) => {
    const {fetchSyncPost} = require("../util/fetch") as {
        fetchSyncPost: (url: string, data: FormData) => Promise<NativeUploadResponse>;
    };
    return fetchSyncPost("/upload", formData);
};

const isNormalizedAssetReference = (value: unknown): value is string => {
    if (typeof value !== "string" || !value.startsWith("assets/") || value.includes("\\")) return false;
    const segments = value.slice("assets/".length).split("/");
    return segments.length > 0 && segments.every((segment) => segment !== "." && segment !== ".." &&
        ASSET_REFERENCE_SEGMENT.test(segment));
};

const selectionSnapshot = (selection: AssetSelectionBookmark): AssetSelectionBookmark => ({...selection});

const isImageFile = (file: File): boolean => file.type.toLowerCase().startsWith("image/") ||
    /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i.test(file.name);

const validateImageFiles = (files: File[], maxBytes: number): string[] => files
    .filter((file) => !file.name || !isImageFile(file) || file.size > maxBytes)
    .map((file) => file.name || "<unnamed>");

const uploadBatch = async (
    files: File[],
    selection: AssetSelectionBookmark,
    transport: AssetUploadTransport,
): Promise<AssetImportResult> => {
    const capturedSelection = selectionSnapshot(selection);
    const formData = new FormData();
    files.forEach((file) => formData.append("file[]", file));

    let response: NativeUploadResponse;
    try {
        response = await transport(formData);
    } catch (_error) {
        return {ok: false, kind: "request", selection: capturedSelection};
    }

    if (response?.code !== 0 || !response.data || !response.data.succMap ||
        typeof response.data.succMap !== "object" || Array.isArray(response.data.succMap)) {
        return {ok: false, kind: "response", selection: capturedSelection};
    }

    const successMap = response.data.succMap as Record<string, unknown>;
    const errorFiles = response.data.errFiles;
    if (Array.isArray(errorFiles) && errorFiles.length > 0) {
        return {
            ok: false,
            kind: "response",
            selection: capturedSelection,
            rejectedFiles: errorFiles.filter((file): file is string => typeof file === "string"),
        };
    }

    const references: string[] = [];
    for (const file of files) {
        const reference = successMap[file.name];
        if (!isNormalizedAssetReference(reference)) {
            return {ok: false, kind: "response", selection: capturedSelection};
        }
        references.push(reference);
    }
    return {ok: true, references, selection: capturedSelection};
};

export const importImages = async (
    files: File[],
    selection: AssetSelectionBookmark,
    transport: AssetUploadTransport = defaultTransport,
    options: AssetImportOptions = {},
): Promise<AssetImportResult> => {
    const capturedSelection = selectionSnapshot(selection);
    if (!Array.isArray(files) || files.length === 0 || files.some((file) => !(file instanceof File))) {
        return {ok: false, kind: "response", selection: capturedSelection};
    }
    const rejectedFiles = validateImageFiles(files, options.maxBytes ?? DEFAULT_NATIVE_UPLOAD_MAX_BYTES);
    if (rejectedFiles.length > 0) {
        return {ok: false, kind: "validation", selection: capturedSelection, rejectedFiles};
    }

    const hasDuplicateName = new Set(files.map((file) => file.name)).size !== files.length;
    if (!hasDuplicateName) return uploadBatch(files, capturedSelection, transport);

    const references: string[] = [];
    for (const file of files) {
        const result = await uploadBatch([file], capturedSelection, transport);
        if (!result.ok) return result;
        references.push(...result.references);
    }
    return {ok: true, references, selection: capturedSelection};
};
