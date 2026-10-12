/* global QOL_REMOTE_CODEC, QOL_GITHUB_SOURCE, window, location, document, URLSearchParams, fetch, crypto, TextEncoder, AbortController */
// One cached tiny page for every lane. Fragment ACKs do not reload CEF.
(() => {
    "use strict";
    const codec = QOL_REMOTE_CODEC, query = new URLSearchParams(location.search);
    const session = query.get("s"), lane = Number(query.get("lane")), lanes = Number(query.get("lanes"));
    let meta, packed, index, sequence = 0, waiting = -1, retry = null, ended = false, frameCache = null, progressAt = -Infinity;
    const sourceAbort = typeof AbortController === "function" ? new AbortController() : null;
    function send(frame) {
        const title = "QOL_CODE:" + JSON.stringify({ s: session, lane, q: ++sequence, ...frame });
        if (title.length > 4096) throw new Error("Title overflow");
        document.title = title;
    }
    function emit() {
        if (ended) return;
        if (!frameCache) frameCache = waiting === -1 ? { kind: "manifest", meta }
            : { kind: "chunk", index: waiting, data: codec.base64(packed.subarray(waiting * codec.CHUNK_BYTES, (waiting + 1) * codec.CHUNK_BYTES)) };
        send(frameCache);
    }
    function finish() { ended = true; sourceAbort?.abort(); if (retry !== null) clearInterval(retry); retry = null; packed = null; }
    function acknowledge() {
        if (ended || !meta || !packed) return;
        let ack;
        try { ack = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch (_) { return; }
        if (!ack || ack.s !== session || ack.ack !== waiting) return;
        index = waiting === -1 ? lane : waiting + lanes;
        if (index >= meta.chunks) { finish(); return; }
        waiting = index;
        frameCache = null;
        emit();
    }
    window.addEventListener("hashchange", acknowledge);
    window.addEventListener("pagehide", finish);
    async function start() {
        if (!/^[a-z0-9_]{1,64}$/.test(session || "") || !Number.isInteger(lanes) || lanes < 1 || lanes > 4 ||
            !Number.isInteger(lane) || lane < 0 || lane >= lanes) throw new Error("Invalid lane parameters");
        let revision = query.get("revision");
        if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid revision");
        const layout = query.get("layout");
        if (layout && (!/^panorama\/layout\/[A-Za-z0-9_./-]+\.xml$/.test(layout) || layout.includes(".."))) throw new Error("Invalid layout scope");
        const key = layout ? codec.checksum(Array.from(layout, c => c.charCodeAt(0))) : null;
        if (typeof QOL_GITHUB_SOURCE !== "undefined") {
            const snapshot = await QOL_GITHUB_SOURCE.load({ revision, layout, signal: sourceAbort?.signal,
                onProgress: detail => {
                    if (ended || Date.now() - progressAt < 250) return;
                    progressAt = Date.now(); send({ kind: "progress", ...detail });
                } });
            if (ended) return;
            const raw = new TextEncoder().encode(JSON.stringify(snapshot));
            packed = codec.pack(raw);
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", packed));
            meta = codec.validateManifest({ revision: snapshot.revision, bytes: packed.length, rawBytes: raw.length,
                chunks: Math.ceil(packed.length / codec.CHUNK_BYTES), checksum: codec.checksum(packed),
                sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join(""),
                ...(layout ? { scope: layout, profile: key } : {}) });
            if (ended) return;
            emit(); retry = setInterval(emit, 750); return;
        }
        // Scope indices must not keep serving an old layout after main removes
        // it: resolve current release first, then use its immutable profile.
        if (!revision && key) {
            const latest = await fetch("manifest.json", { cache: "no-cache" });
            if (!latest.ok) throw new Error("Release index HTTP " + latest.status);
            revision = codec.validateManifest(await latest.json()).revision;
        }
        const manifestPath = key ? "profiles/" + key + ".json" : "manifest.json";
        const manifestURL = (revision ? "releases/" + revision + "/" : "") + manifestPath;
        const response = await fetch(manifestURL, { cache: revision ? "default" : "no-cache" });
        if (!response.ok) throw new Error("Manifest HTTP " + response.status);
        meta = codec.validateManifest(await response.json());
        if (revision && meta.revision !== revision) throw new Error("Pinned revision mismatch");
        if ((meta.scope || null) !== layout || (meta.profile || null) !== key) throw new Error("Profile identity mismatch");
        const data = await fetch("releases/" + meta.revision + "/" + (key ? "profiles/" + key + ".bin" : "snapshot.bin"));
        if (!data.ok) throw new Error("Snapshot HTTP " + data.status);
        packed = new Uint8Array(await data.arrayBuffer());
        if (packed.length !== meta.bytes || codec.checksum(packed) !== meta.checksum) throw new Error("Snapshot transport checksum mismatch");
        if (!crypto || !crypto.subtle) throw new Error("CEF SHA-256 unavailable");
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", packed));
        const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
        if (hex !== meta.sha256) throw new Error("Snapshot SHA-256 mismatch");
        emit();
        retry = setInterval(emit, 750);
    }
    start().catch(error => { finish(); send({ kind: "error", error: String(error.message || error).slice(0, 160) }); });
})();
