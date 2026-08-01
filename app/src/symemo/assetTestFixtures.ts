export const buildAssetFiles = (...names: string[]): File[] => names.map((name) =>
    new File([new Uint8Array([1, 2, 3])], name, {type: "image/png"}));

export const buildAssetUploadResponse = (entries: Record<string, string>) => ({
    code: 0,
    msg: "",
    data: {
        succMap: entries,
        errFiles: [] as string[],
    },
});

export const assetCaretBookmark = (id = "asset-caret") => ({id});

export const assetHTML = (references: string[]): string => references.map((reference) =>
    `<p><img src="${reference}" alt="fixture"></p>`).join("");
