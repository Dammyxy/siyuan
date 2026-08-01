import {before, describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {buildAssetFiles, buildAssetUploadResponse} from "./assetTestFixtures";

let importImages: typeof import("./assetStore").importImages;
let uploaded: unknown;

before(async () => {
    const fetchPath = require.resolve("../util/fetch");
    require.cache[fetchPath] = {
        exports: {
            fetchSyncPost: async (_url: string, data: unknown) => {
                uploaded = data;
                return buildAssetUploadResponse({
                    "alpha.png": "assets/alpha-2.png",
                    "beta.png": "assets/beta-1.png",
                });
            },
        },
    } as NodeModule;
    ({importImages} = await import("./assetStore"));
});

describe("Native AssetStore", () => {
    it("uploads through the native FormData contract and preserves input order", async () => {
        const files = buildAssetFiles("beta.png", "alpha.png");
        const result = await importImages(files, {id: "caret"});

        assert.deepEqual(result, {
            ok: true,
            references: ["assets/beta-1.png", "assets/alpha-2.png"],
            selection: {id: "caret"},
        });
        assert.equal(uploaded instanceof FormData, true);
        assert.deepEqual((uploaded as FormData).getAll("file[]"), files);
    });

    it("does not turn a malformed native response into a local path or placeholder", async () => {
        const result = await importImages([buildAssetFiles("only.png")[0]], {id: "caret"}, async () => ({
            code: 0,
            msg: "",
            data: {succMap: {}, errFiles: ["only.png"]},
        }));

        assert.deepEqual(result, {
            ok: false,
            kind: "response",
            selection: {id: "caret"},
            rejectedFiles: ["only.png"],
        });
    });

    it("rejects non-image and oversized files before native upload", async () => {
        let transportCalls = 0;
        const transport = async () => {
            transportCalls++;
            return buildAssetUploadResponse({"note.txt": "assets/note.txt"});
        };

        const nonImage = new File(["text"], "note.txt", {type: "text/plain"});
        const invalidType = await importImages([nonImage], {id: "caret"}, transport);
        assert.deepEqual(invalidType, {
            ok: false,
            kind: "validation",
            selection: {id: "caret"},
            rejectedFiles: ["note.txt"],
        });

        const oversized = await importImages(
            [buildAssetFiles("large.png")[0]],
            {id: "caret"},
            transport,
            {maxBytes: 1},
        );
        assert.deepEqual(oversized, {
            ok: false,
            kind: "validation",
            selection: {id: "caret"},
            rejectedFiles: ["large.png"],
        });
        assert.equal(transportCalls, 0);
    });

    it("uploads duplicate file names separately so each reference keeps input order", async () => {
        const responses = [
            buildAssetUploadResponse({"same.png": "assets/first.png"}),
            buildAssetUploadResponse({"same.png": "assets/second.png"}),
        ];
        let transportCalls = 0;
        const result = await importImages(
            [buildAssetFiles("same.png")[0], buildAssetFiles("same.png")[0]],
            {id: "caret"},
            async () => {
                transportCalls++;
                return responses.shift()!;
            },
        );

        assert.deepEqual(result, {
            ok: true,
            references: ["assets/first.png", "assets/second.png"],
            selection: {id: "caret"},
        });
        assert.equal(transportCalls, 2);
    });

    it("rejects traversal segments in native references", async () => {
        const result = await importImages([buildAssetFiles("unsafe.png")[0]], {id: "caret"}, async () =>
            buildAssetUploadResponse({"unsafe.png": "assets/nested/../unsafe.png"}));

        assert.deepEqual(result, {ok: false, kind: "response", selection: {id: "caret"}});
    });
});
