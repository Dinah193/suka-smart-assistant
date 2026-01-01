// src/components/meals/collector/UrlImportPanel.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let eventBus = null;
try {
  eventBus = require("@/services/eventBus").eventBus || null;
} catch {}

let automation = null;
try {
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

let Icons = {};
try {
  Icons = require("lucide-react");
} catch (e) {
  Icons = {};
}

let TaggingPanel = null;
try {
  TaggingPanel = require("./TaggingPanel.jsx").default || null;
} catch {}

let SourceAttributionCard = null;
try {
  SourceAttributionCard = require("./SourceAttributionCard.jsx").default || null;
} catch {}

let SendToMenu = null;
try {
  SendToMenu = require("./SendToMenu.jsx").default || null;
} catch {}

let CollectionsPicker = null;
try {
  CollectionsPicker = require("./CollectionsPicker.jsx").default || null;
} catch {}

/* ----------------------------- Local helper utils ---------------------------- */
const URL_REGEX =
  /\b(https?:\/\/(?:www\.)?[^\s/$.?#].[^\s]*)/gi; // liberal; we normalize later

const stripUtm = (u) => {
  try {
    const url = new URL(u.trim());
    // Drop common tracking params
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((p) =>
      url.searchParams.delete(p)
    );
    // Optional: canonicalize hostname (remove trailing dot)
    url.hostname = url.hostname.replace(/\.$/, "");
    return url.toString();
  } catch {
    return u.trim();
  }
};

const uniq = (arr) => Array.from(new Set(arr));

const classifyDomain = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (/(pinterest|pinimg)\./.test(h)) return "pinboard";
    if (/(youtube|youtu\.be)\./.test(h)) return "video";
    if (/(tiktok)\./.test(h)) return "video";
    if (/(allrecipes|foodnetwork|epicurious|seriouseats|tasteofhome)\./.test(h)) return "recipe";
    return "web";
  } catch {
    return "unknown";
  }
};

const validateUrlShape = (u) => {
  try {
    const url = new URL(u);
    return /^https?:/.test(url.protocol);
  } catch {
    return false;
  }
};

/* ------------------------------ Toast (defensive) ----------------------------- */
let toast = { success: console.log, error: console.error, info: console.log, warn: console.warn };
try {
  const mod = require("react-toastify");
  toast = mod.toast || toast;
} catch {}

/* ------------------------------- Main component ------------------------------ */
const UrlImportPanel = ({
  defaultCollectionId = null,
  onImported, // callback(urlEntries)
  compact = false,
}) => {
  const [raw, setRaw] = useState("");
  const [urls, setUrls] = useState([]); // [{id, url, class, valid, title?, note?}]
  const [selected, setSelected] = useState(new Set());
  const [isValidating, setIsValidating] = useState(false);
  const [tags, setTags] = useState([]);
  const [collectionId, setCollectionId] = useState(defaultCollectionId);
  const [attribution, setAttribution] = useState({ source: "", author: "", license: "", notes: "" });
  const dropRef = useRef(null);

  /* ------------------------------ Parse & extract ----------------------------- */
  const extractUrls = useCallback((text) => {
    const matches = text.match(URL_REGEX) || [];
    const cleaned = uniq(matches.map(stripUtm).filter(Boolean));
    return cleaned.map((u, i) => ({
      id: `${i}-${u}`,
      url: u,
      class: classifyDomain(u),
      valid: validateUrlShape(u),
    }));
  }, []);

  const parseFromRaw = useCallback(() => {
    const items = extractUrls(raw);
    setUrls(items);
    setSelected(new Set(items.map((x) => x.id))); // select all by default
    if (!items.length) toast.info("No URLs detected. Paste links or drop cards to begin.");
  }, [raw, extractUrls]);

  /* ----------------------------- Drag & Drop intake --------------------------- */
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const prevent = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDrop = (e) => {
      prevent(e);
      try {
        // Accept text/uri-list, text/plain, or custom recipe cards as JSON
        const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "";
        const urlsFromDrop = extractUrls(text);
        if (urlsFromDrop.length) {
          const merged = uniq([...urls.map((x) => x.url), ...urlsFromDrop.map((x) => x.url)]).map((u, i) => ({
            id: `${i}-${u}`,
            url: u,
            class: classifyDomain(u),
            valid: validateUrlShape(u),
          }));
          setUrls(merged);
          setSelected(new Set(merged.map((x) => x.id)));
          toast.success(`Added ${urlsFromDrop.length} link(s) from drop.`);
        } else {
          toast.info("No URLs found in dropped content.");
        }
      } catch {
        toast.error("Could not parse dropped content.");
      }
    };
    ["dragenter", "dragover", "dragleave", "drop"].forEach((evt) => el.addEventListener(evt, prevent));
    el.addEventListener("drop", onDrop);
    return () => {
      ["dragenter", "dragover", "dragleave", "drop"].forEach((evt) => el.removeEventListener(evt, prevent));
      el.removeEventListener("drop", onDrop);
    };
  }, [urls, extractUrls]);

  /* --------------------------------- Actions --------------------------------- */
  const doClipboardImport = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        toast.info("Clipboard is empty.");
        return;
      }
      setRaw((prev) => (prev?.length ? prev + "\n" + text : text));
      // auto-parse
      const items = extractUrls(text);
      if (items.length) {
        const merged = uniq([...urls.map((x) => x.url), ...items.map((x) => x.url)]).map((u, i) => ({
          id: `${i}-${u}`,
          url: u,
          class: classifyDomain(u),
          valid: validateUrlShape(u),
        }));
        setUrls(merged);
        setSelected(new Set(merged.map((x) => x.id)));
        toast.success(`Imported ${items.length} URL(s) from clipboard.`);
      } else {
        toast.info("No URLs found in clipboard content.");
      }
    } catch {
      toast.error("Clipboard access denied by the browser.");
    }
  }, [extractUrls, urls]);

  const doValidate = useCallback(async () => {
    // Lightweight client validation (shape only). Avoids CORS fetches.
    setIsValidating(true);
    try {
      const checked = urls.map((u) => ({
        ...u,
        valid: validateUrlShape(u.url),
      }));
      setUrls(checked);
      toast.success("Quick validation complete.");
    } finally {
      setIsValidating(false);
    }
  }, [urls]);

  const selectedEntries = useMemo(() => urls.filter((u) => selected.has(u.id)), [urls, selected]);

  const emitImport = useCallback(
    (destination) => {
      if (!selectedEntries.length) {
        toast.info("Select at least one URL to continue.");
        return;
      }
      const payload = {
        destination, // "library" | "batchQueue" | "mealPlan" | "groceryList"
        urls: selectedEntries,
        tags,
        collectionId,
        attribution,
        ts: Date.now(),
      };

      // eventBus emit (if present)
      try {
        if (eventBus?.emit) {
          eventBus.emit("meals.collector.urlsImported", payload);
        }
      } catch {}

      // automation tap (optional)
      try {
        if (automation?.runTemplate) {
          automation.runTemplate("meals.urls.imported", { payload });
        }
      } catch {}

      onImported?.(payload);
      toast.success(`Sent ${selectedEntries.length} link(s) to ${destination}.`);
    },
    [selectedEntries, tags, collectionId, attribution, onImported]
  );

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeEntry = (id) => {
    setUrls((prev) => prev.filter((x) => x.id !== id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const clearAll = () => {
    setUrls([]);
    setSelected(new Set());
    setRaw("");
  };

  /* -------------------------------- Shortcuts -------------------------------- */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "enter") {
        emitImport("library");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [emitImport]);

  /* --------------------------------- Rendering -------------------------------- */
  const {
    UploadCloud = () => null,
    ClipboardPaste = () => null,
    Check = () => null,
    X = () => null,
    Link2 = () => null,
    Tags = () => null,
    Send = () => null,
    Shield = () => null,
    Trash2 = () => null,
    Sparkles = () => null,
    ListPlus = () => null,
    ExternalLink = () => null,
  } = Icons;

  const Header = () => (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <UploadCloud className="w-5 h-5" />
        <h3 className="text-xl font-semibold">URL Collector</h3>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="px-3 py-1.5 rounded-md border hover:bg-gray-50"
          onClick={doClipboardImport}
          title="Import from Clipboard"
        >
          <div className="flex items-center gap-2">
            <ClipboardPaste className="w-4 h-4" />
            <span>Paste</span>
          </div>
        </button>
        <button
          className="px-3 py-1.5 rounded-md border hover:bg-gray-50"
          onClick={doValidate}
          disabled={!urls.length || isValidating}
          title="Quick Validate"
        >
          <div className="flex items-center gap-2">
            <Shield className={`w-4 h-4 ${isValidating ? "animate-pulse" : ""}`} />
            <span>Validate</span>
          </div>
        </button>
        <button className="px-3 py-1.5 rounded-md border hover:bg-gray-50" onClick={clearAll} title="Clear">
          <div className="flex items-center gap-2">
            <Trash2 className="w-4 h-4" />
            <span>Clear</span>
          </div>
        </button>
      </div>
    </div>
  );

  const PasteArea = () => (
    <div
      ref={dropRef}
      className={`rounded-xl border border-dashed p-3 mb-3 transition-colors ${
        urls.length ? "border-gray-200" : "border-gray-300"
      }`}
    >
      <label htmlFor="url-paste" className="text-sm font-medium text-gray-700 flex items-center gap-2 mb-1">
        <Link2 className="w-4 h-4" /> Paste links (one per line) or drop recipe cards/links
      </label>
      <textarea
        id="url-paste"
        className="w-full min-h-[90px] rounded-md border p-2 text-sm"
        placeholder="https://example.com/recipe/...\nhttps://youtu.be/..."
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={parseFromRaw}
      />
      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>Tip: We’ll auto-remove UTM tracking, dedupe, and classify sources.</span>
        <button
          className="underline underline-offset-2 hover:text-gray-700"
          onClick={parseFromRaw}
          type="button"
        >
          Parse now
        </button>
      </div>
    </div>
  );

  const SelectedSummary = () => (
    <div className="flex items-center justify-between mb-2">
      <div className="text-sm text-gray-600">
        <strong>{selectedEntries.length}</strong> selected / {urls.length} total
      </div>
      <div className="flex items-center gap-2 text-xs">
        <button
          className="px-2 py-1 rounded border hover:bg-gray-50"
          onClick={() => setSelected(new Set(urls.map((x) => x.id)))}
        >
          Select all
        </button>
        <button className="px-2 py-1 rounded border hover:bg-gray-50" onClick={() => setSelected(new Set())}>
          Select none
        </button>
      </div>
    </div>
  );

  const UrlRow = ({ item }) => (
    <div className="flex items-start gap-3 p-2 rounded-md border mb-2">
      <input
        type="checkbox"
        className="mt-1"
        checked={selected.has(item.id)}
        onChange={() => toggle(item.id)}
        aria-label={`Select ${item.url}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border ${
              item.class === "recipe"
                ? "bg-green-50 border-green-200 text-green-700"
                : item.class === "video"
                ? "bg-blue-50 border-blue-200 text-blue-700"
                : item.class === "pinboard"
                ? "bg-pink-50 border-pink-200 text-pink-700"
                : "bg-gray-50 border-gray-200 text-gray-700"
            }`}
            title="Detected source type"
          >
            {item.class}
          </span>
          {item.valid ? (
            <span className="inline-flex items-center gap-1 text-green-700 text-xs">
              <Check className="w-3 h-3" /> valid
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-red-700 text-xs">
              <X className="w-3 h-3" /> invalid
            </span>
          )}
        </div>
        <div className="mt-1 text-sm break-all">
          <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline inline-flex items-center gap-1">
            {item.url}
            <ExternalLink className="w-3 h-3 opacity-60" />
          </a>
        </div>
        {/* Optional per-item notes (lightweight) */}
        {/* <input className="mt-2 w-full border rounded p-1 text-xs" placeholder="Add a note (optional)" /> */}
      </div>
      <button
        className="px-2 py-1 rounded border hover:bg-gray-50 text-xs"
        onClick={() => removeEntry(item.id)}
        title="Remove"
        type="button"
      >
        Remove
      </button>
    </div>
  );

  const UrlList = () => (
    <div className="max-h-[40vh] overflow-auto rounded-md">
      {urls.length === 0 ? (
        <div className="text-sm text-gray-500 p-6 text-center">
          <p>No URLs yet. Paste links, use the Paste button, or drag & drop.</p>
        </div>
      ) : (
        urls.map((u) => <UrlRow key={u.id} item={u} />)
      )}
    </div>
  );

  const MetaPanels = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2 mb-2">
          <Tags className="w-4 h-4" />
          <h4 className="font-medium">Tags</h4>
        </div>
        {TaggingPanel ? (
          <TaggingPanel value={tags} onChange={setTags} compact />
        ) : (
          <input
            className="w-full border rounded p-2 text-sm"
            placeholder="Comma-separated tags (fallback)"
            value={tags.join(", ")}
            onChange={(e) => setTags(e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
          />
        )}
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4" />
          <h4 className="font-medium">Source & Attribution</h4>
        </div>
        {SourceAttributionCard ? (
          <SourceAttributionCard value={attribution} onChange={setAttribution} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input
              className="border rounded p-2 text-sm"
              placeholder="Source (site/channel)"
              value={attribution.source}
              onChange={(e) => setAttribution((p) => ({ ...p, source: e.target.value }))}
            />
            <input
              className="border rounded p-2 text-sm"
              placeholder="Author/Creator"
              value={attribution.author}
              onChange={(e) => setAttribution((p) => ({ ...p, author: e.target.value }))}
            />
            <input
              className="border rounded p-2 text-sm"
              placeholder="License/Usage"
              value={attribution.license}
              onChange={(e) => setAttribution((p) => ({ ...p, license: e.target.value }))}
            />
            <input
              className="border rounded p-2 text-sm md:col-span-2"
              placeholder="Notes"
              value={attribution.notes}
              onChange={(e) => setAttribution((p) => ({ ...p, notes: e.target.value }))}
            />
          </div>
        )}
      </div>

      <div className="rounded-lg border p-3 md:col-span-2">
        <div className="flex items-center gap-2 mb-2">
          <ListPlus className="w-4 h-4" />
          <h4 className="font-medium">Collection</h4>
        </div>
        {CollectionsPicker ? (
          <CollectionsPicker value={collectionId} onChange={setCollectionId} />
        ) : (
          <input
            className="border rounded p-2 text-sm w-full"
            placeholder="Collection ID or Name"
            value={collectionId || ""}
            onChange={(e) => setCollectionId(e.target.value)}
          />
        )}
      </div>
    </div>
  );

  const SendActions = () => (
    <div className={`rounded-lg border p-3 ${compact ? "mt-2" : "mt-3"}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Send className="w-4 h-4" />
          <h4 className="font-medium">Send to</h4>
        </div>
        <div className="text-xs text-gray-500">⌘/Ctrl + Enter → Library</div>
      </div>

      {SendToMenu ? (
        <SendToMenu
          disabled={!selectedEntries.length}
          onSend={(dest) => emitImport(dest)}
          options={[
            { id: "library", label: "Recipe Library" },
            { id: "batchQueue", label: "Batch Cooking Queue" },
            { id: "mealPlan", label: "Meal Plan (Decide/Plan)" },
            { id: "groceryList", label: "Grocery List Generator" },
          ]}
        />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <button
            className="px-3 py-2 rounded-md border hover:bg-gray-50 disabled:opacity-40"
            disabled={!selectedEntries.length}
            onClick={() => emitImport("library")}
          >
            Recipe Library
          </button>
          <button
            className="px-3 py-2 rounded-md border hover:bg-gray-50 disabled:opacity-40"
            disabled={!selectedEntries.length}
            onClick={() => emitImport("batchQueue")}
          >
            Batch Queue
          </button>
          <button
            className="px-3 py-2 rounded-md border hover:bg-gray-50 disabled:opacity-40"
            disabled={!selectedEntries.length}
            onClick={() => emitImport("mealPlan")}
          >
            Meal Plan
          </button>
          <button
            className="px-3 py-2 rounded-md border hover:bg-gray-50 disabled:opacity-40"
            disabled={!selectedEntries.length}
            onClick={() => emitImport("groceryList")}
          >
            Grocery List
          </button>
        </div>
      )}
    </div>
  );

  return (
    <section className={`rounded-2xl border p-4 ${compact ? "bg-white" : "bg-white/80"} backdrop-blur`}>
      <Header />
      <PasteArea />
      <SelectedSummary />
      <UrlList />
      <div className="my-3" />
      <MetaPanels />
      <SendActions />
    </section>
  );
};

export default UrlImportPanel;
