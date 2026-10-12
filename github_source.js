/* global fetch, crypto, TextEncoder */
// Runs in the hosted HTML page, never in Panorama. No Git executable or server
// build is needed: resolve main once and fetch immutable public source blobs.
(() => {
    "use strict";
    const repository = "civo7/QOLLOCK", branch = "main";
    const api = "https://api.github.com/repos/" + repository;
    function includes(xml, group, suffix) {
        const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
        const block = clean.match(new RegExp("<" + group + ">([\\s\\S]*?)</" + group + ">"));
        return block ? Array.from(block[1].matchAll(/<include\s+src="s2r:\/\/(.*?)"\s*\/>/g), m =>
            m[1].replace(new RegExp("\\." + suffix + "(?:_c)?$"), group === "scripts" ? ".js" : ".css")) : [];
    }
    async function load({ revision, layout, signal, onProgress = () => {} } = {}) {
        async function json(url, cache = "default") {
            const response = await fetch(url, { cache, signal, headers: { Accept: "application/vnd.github+json" } });
            if (!response.ok) throw Error("GitHub HTTP " + response.status);
            return response.json();
        }
        if (!revision) {
            const ref = await json(api + "/git/ref/heads/" + branch, "no-cache");
            if (ref.object?.type !== "commit") throw Error("Main is not a commit reference");
            revision = ref.object.sha;
        }
        if (!/^[a-f0-9]{40}$/.test(revision || "")) throw Error("Invalid source revision");
        onProgress({ stage: "tree", revision });
        const tree = await json(api + "/git/trees/" + revision + "?recursive=1");
        if (tree.truncated || !Array.isArray(tree.tree)) throw Error("Incomplete GitHub source tree");
        const blobs = new Map(tree.tree.filter(item => item.type === "blob" && /^panorama\/[A-Za-z0-9_./-]+\.(?:js|css|xml)$/.test(item.path) && !item.path.includes("..")).map(item => [item.path, item]));
        if (layout && (!/^panorama\/layout\/[A-Za-z0-9_./-]+\.xml$/.test(layout) || layout.includes("..") || !blobs.has(layout))) throw Error("Unknown main layout");
        const files = {}, requests = new Map(), encoder = new TextEncoder();
        let completed = 0, totalBytes = 0;
        function source(name) {
            if (requests.has(name)) return requests.get(name);
            const item = blobs.get(name);
            if (!item || !/^[a-f0-9]{40}$/.test(item.sha) || !Number.isInteger(item.size) || item.size < 0 || item.size > 16 * 1024 * 1024) throw Error("Invalid source blob: " + name);
            const pending = (async () => {
                const response = await fetch("https://raw.githubusercontent.com/" + repository + "/" + revision + "/" + name, { cache: "default", signal });
                if (!response.ok) throw Error("Source HTTP " + response.status + ": " + name);
                const text = await response.text(), bytes = encoder.encode(text);
                if (bytes.length !== item.size) throw Error("Source byte count mismatch: " + name);
                const header = encoder.encode("blob " + bytes.length + "\0"), blob = new Uint8Array(header.length + bytes.length);
                blob.set(header); blob.set(bytes, header.length);
                const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", blob));
                if (Array.from(digest, n => n.toString(16).padStart(2, "0")).join("") !== item.sha) throw Error("Source blob hash mismatch: " + name);
                totalBytes += bytes.length;
                if (totalBytes > 16 * 1024 * 1024) throw Error("Source snapshot exceeds byte limit");
                files[name] = text; onProgress({ stage: "sources", revision, completed: ++completed }); return text;
            })();
            requests.set(name, pending); return pending;
        }
        async function batch(names) {
            let next = 0;
            await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
                while (next < names.length) await source(names[next++]);
            }));
        }
        function plan(name) {
            return { path: name, scripts: includes(files[name], "scripts", "vjs"), styles: includes(files[name], "styles", "vcss") };
        }
        let layouts;
        if (layout) {
            await source(layout); layouts = [plan(layout)];
            for (const name of layouts[0].scripts) if (!blobs.has(name)) throw Error("Missing main script: " + name);
            await batch([...new Set([...layouts[0].scripts, ...layouts[0].styles.filter(name => blobs.has(name))])].sort());
            // Include transitive mod CSS; engine-only imports remain native.
            const scanned = new Set();
            while (true) {
                const pending = new Set();
                for (const name of Object.keys(files).filter(n => n.endsWith(".css") && !scanned.has(n))) {
                    scanned.add(name);
                    for (const match of files[name].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@import\s+url\(\s*["']s2r:\/\/([^"']+)["']\s*\)/g)) {
                        const child = match[1].replace(/\.vcss(?:_c)?$/, ".css");
                        if (blobs.has(child) && !(child in files)) pending.add(child);
                    }
                }
                if (!pending.size) break; await batch([...pending].sort());
            }
        } else {
            await batch([...blobs.keys()].sort());
            layouts = [...blobs.keys()].filter(n => n.endsWith(".xml")).sort().map(plan);
            for (const item of layouts) for (const name of item.scripts) if (!(name in files)) throw Error("Missing main script: " + name);
        }
        // Stable property order gives every lane exactly the same bytes.
        return { revision, files: Object.fromEntries(Object.keys(files).sort().map(name => [name, files[name]])), layouts };
    }
    globalThis.QOL_GITHUB_SOURCE = { load };
})();
