/* eslint-disable no-console */
// src/components/mdx/ArticleLayout.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* ------------------------------ Design tokens ------------------------------ */
const cx = (...c) => c.filter(Boolean).join(" ");
const WRAP = "relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8";
const PROSE =
  "prose prose-neutral max-w-none prose-h1:mb-4 prose-h2:mt-10 prose-h3:mt-8 prose-img:rounded-2xl prose-a:font-semibold hover:prose-a:underline";
const BTN =
  "inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle: "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-gray-700";

/* ----------------------------- Defensive imports ---------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch (_) {}

let automation = null;
try {
  const a = require("@/services/automation/runtime");
  automation = a?.automation || a?.default || null;
} catch (_) {}

let useFavoritePlans = null;
try {
  const mod = require("@/hooks/useFavoritePlans");
  useFavoritePlans = mod?.useFavoritePlans || mod?.default || null;
} catch (_) {}

/* Optional: prefer your SavePlan modal if it exists */
let SavePlanModalLazy = null;
try {
  SavePlanModalLazy = React.lazy(() => import("@/components/plans/SavePlanModal.jsx"));
} catch (_) {}

/* Optional: SystemCTA (to surface plan CTAs inside articles) */
let SystemCTA = null;
try {
  const m = require("@/components/cta/SystemCTA.jsx");
  SystemCTA = m?.default || null;
} catch (_) {}

/* ------------------------------- Lucide icons ------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Heart: L.Heart,
    HeartOff: L.HeartOff,
    BookmarkPlus: L.BookmarkPlus,
    Clock: L.Clock3,
    Calendar: L.Calendar,
    Share: L.Share2,
    Link: L.Link,
    Printer: L.Printer,
    Download: L.Download,
    ChevronRight: L.ChevronRight,
    ArrowLeft: L.ArrowLeft,
    Star: L.Star,
    Sparkles: L.Sparkles,
    ExternalLink: L.ExternalLink,
    BookOpen: L.BookOpen,
  };
} catch (_) {
  I = {
    Heart: () => <span>♥</span>,
    HeartOff: () => <span>♡</span>,
    BookmarkPlus: () => <span>🔖</span>,
    Clock: () => <span>🕒</span>,
    Calendar: () => <span>📅</span>,
    Share: () => <span>⤴</span>,
    Link: () => <span>🔗</span>,
    Printer: () => <span>🖨</span>,
    Download: () => <span>⬇</span>,
    ChevronRight: () => <span>›</span>,
    ArrowLeft: () => <span>←</span>,
    Star: () => <span>★</span>,
    Sparkles: () => <span>✦</span>,
    ExternalLink: () => <span>↗</span>,
    BookOpen: () => <span>📖</span>,
  };
}

/* ---------------------------------- Utils ---------------------------------- */
const safeFile = (s = "article") =>
  String(s).toLowerCase().replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-");

const fmt = (d) => {
  try {
    return new Date(d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return d || "";
  }
};

const estReadTime = (text = "", fallbackMin = 5) => {
  try {
    const words = text.trim().split(/\s+/).length;
    return Math.max(1, Math.round(words / 220)) || fallbackMin;
  } catch {
    return fallbackMin;
  }
};

const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

function toastSafe(message, variant = "success") {
  try {
    eventBus.emit("ui.toast", { message, variant });
  } catch (_) {
    if (variant === "error") console.warn(message);
    else console.log(message);
  }
}

/* ------------------------------ JSON-LD builder ----------------------------- */
function ArticleJsonLD({ data }) {
  const json = useMemo(() => {
    const {
      title,
      description,
      date,
      updated,
      author = {},
      tags = [],
      cover,
      canonical,
    } = data || {};
    const base = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: title,
      description: description,
      datePublished: date,
      dateModified: updated || date,
      author: author?.name ? { "@type": "Person", name: author.name } : undefined,
      image: cover ? [cover] : undefined,
      keywords: tags.join(", "),
      mainEntityOfPage: canonical ? { "@type": "WebPage", "@id": canonical } : undefined,
    };
    return JSON.stringify(base, null, 2);
  }, [data]);
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

/* -------------------------------- Component --------------------------------- */
/**
 * ArticleLayout
 * -----------------------------------------------------------------------------
 * Props (frontmatter):
 *  - title, description, date, updated, author{name, avatar, byline}, tags[],
 *    cover (url), coverAlt, breadcrumbs[{label, href}], canonical, slug,
 *    readingTime (minutes), domain (for plan CTA), plan (optional plan object or id),
 *    related: [{title, href, cover}], editUrl (for "Edit on GitHub")
 */
export default function ArticleLayout({ children, frontmatter = {} }) {
  const {
    title = "Untitled",
    description = "",
    date = "",
    updated = "",
    author = {},
    tags = [],
    cover = "",
    coverAlt = "",
    breadcrumbs = [],
    canonical = "",
    slug = "",
    readingTime,
    domain = "articles",
    plan = null,
    related = [],
    editUrl = "",
  } = frontmatter;

  const articleRef = useRef(null);
  const [progress, setProgress] = useState(0);
  const [toc, setToc] = useState([]);
  const [openTOC, setOpenTOC] = useState(false);

  /* --------------------------- Favorites (articles) -------------------------- */
  const favApi = useFavoritePlans ? useFavoritePlans("articles") : null;
  const articleId = useMemo(
    () => frontmatter?.id || slug || `article:${safeFile(title)}`,
    [frontmatter?.id, slug, title]
  );
  const isFavInit = !!favApi?.isFavorite?.(articleId);
  const [isFav, setIsFav] = useState(isFavInit);

  useEffect(() => setIsFav(!!favApi?.isFavorite?.(articleId)), [favApi, articleId]);

  const toggleFavorite = async () => {
    try {
      if (favApi?.toggleFavorite) {
        const next = await favApi.toggleFavorite(articleId, frontmatter);
        setIsFav(!!next);
      } else {
        const next = !isFav;
        setIsFav(next);
        eventBus.emit("article.favorite.toggled", { id: articleId, next, source: "ArticleLayout" });
      }
      toastSafe(isFav ? "Removed from favorites." : "Added to favorites.");
    } catch (e) {
      console.warn("[ArticleLayout] favorite toggle failed", e);
      toastSafe("Could not update favorites.", "error");
    }
  };

  /* -------------------------- Reading time / progress ------------------------ */
  const [computedRT, setComputedRT] = useState(readingTime || 0);
  useEffect(() => {
    // compute from visible text if not provided
    if (!readingTime && articleRef.current) {
      const txt = articleRef.current.innerText || "";
      setComputedRT(estReadTime(txt, 6));
    }
  }, [readingTime]);

  useEffect(() => {
    // progress based on scroll within article
    const el = articleRef.current;
    if (!el) return;
    const onScroll = () => {
      const rect = el.getBoundingClientRect();
      const total = el.offsetHeight - (window.innerHeight * 0.2);
      const read = Math.min(Math.max(-rect.top + 80, 0), total);
      setProgress(total > 0 ? Math.round((read / total) * 100) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  /* --------------------------------- TOC scan -------------------------------- */
  useEffect(() => {
    const el = articleRef.current;
    if (!el) return;
    const hs = Array.from(el.querySelectorAll("h2, h3")).map((h) => ({
      id: h.id || (h.textContent || "").toLowerCase().replace(/\s+/g, "-"),
      text: h.textContent || "",
      level: h.tagName.toLowerCase(),
    }));
    // ensure ids exist
    hs.forEach((h) => {
      const node = el.querySelector(h.level === "h2" ? `h2:contains("${h.text}")` : `h3:contains("${h.text}")`);
      if (node && !node.id) node.id = h.id;
    });
    setToc(hs);
  }, [children]);

  /* --------------------------------- SEO/meta -------------------------------- */
  useEffect(() => {
    // Let your SEO subsystem update head tags
    try {
      eventBus.emit("seo.meta.update", {
        title,
        description,
        canonical,
        opengraph: { title, description, image: cover },
        twitter: { card: "summary_large_image" },
      });
    } catch (_) {}
    // track viewed
    eventBus.emit?.("article.viewed", { id: articleId, title, slug, tags, source: "ArticleLayout" });
  }, [title, description, canonical, cover, articleId, slug, tags]);

  /* ----------------------------- Share / export UI ---------------------------- */
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window?.location?.href || canonical || "");
      toastSafe("Link copied.");
    } catch {
      toastSafe("Could not copy link.", "error");
    }
  };

  const shareNative = async () => {
    if (navigator?.share) {
      try {
        await navigator.share({ title, text: description, url: window?.location?.href || canonical });
        eventBus.emit?.("article.share.requested", { id: articleId, channel: "native" });
        return;
      } catch (_) {}
    }
    copyLink();
  };

  const printPDF = () => {
    try {
      window.print();
      eventBus.emit?.("article.export.requested", { id: articleId, format: "print" });
    } catch (_) {}
  };

  const downloadJson = () => {
    try {
      const data = { frontmatter, slug, contentType: "article" };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeFile(title || slug)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toastSafe("Downloaded article JSON.");
    } catch (e) {
      console.warn(e);
      toastSafe("Download failed.", "error");
    }
  };

  /* ------------------------ Optional "Save as Plan" glue ----------------------- */
  const [saveOpen, setSaveOpen] = useState(false);
  const planFromArticle =
    plan && (typeof plan === "object" ? plan : { id: String(plan), title, domain: domain === "articles" ? "meals" : domain });
  const openSavePlan = () => {
    if (!planFromArticle) {
      toastSafe("No plan data in this article.", "error");
      return;
    }
    setSaveOpen(true);
    eventBus.emit?.("plan.save.modal.opened", { from: "ArticleLayout", plan: planFromArticle });
  };

  /* ------------------------------ NBA (optional) ------------------------------ */
  const [nbaHint, setNbaHint] = useState(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const hint = await automation?.nba?.suggest?.({
          domain: domain === "articles" ? planFromArticle?.domain || "meals" : domain,
          plan: planFromArticle || null,
          context: { articleId, tags },
        });
        if (!cancel && hint?.label) setNbaHint(hint.label);
      } catch (_) {}
    })();
    return () => {
      cancel = true;
    };
  }, [domain, articleId, planFromArticle, tags]);

  /* --------------------------------- Render --------------------------------- */
  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-gray-50">
      {/* Top reading progress */}
      <div className="sticky top-0 z-30 h-1 w-full bg-gray-100">
        <div
          className="h-1 bg-indigo-600 transition-[width] ease-out"
          style={{ width: `${progress}%` }}
          aria-hidden="true"
        />
      </div>

      {/* Hero */}
      <header className={cx(WRAP, "pt-10 pb-6")}>
        {/* Breadcrumbs */}
        {breadcrumbs?.length > 0 && (
          <nav className="mb-4 text-sm text-gray-600" aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-1">
              <li>
                <a href="/" className="hover:underline flex items-center gap-1">
                  <I.ArrowLeft className="h-4 w-4" />
                  Back
                </a>
              </li>
              {breadcrumbs.map((bc, i) => (
                <li key={i} className="flex items-center gap-1">
                  <span className="mx-1 text-gray-300">/</span>
                  {bc.href ? (
                    <a href={bc.href} className="hover:underline">
                      {bc.label}
                    </a>
                  ) : (
                    <span>{bc.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}

        <div className="relative overflow-hidden rounded-3xl border border-gray-200 bg-white">
          {cover ? (
            <div className="relative h-56 w-full sm:h-72 lg:h-80">
              <img
                src={cover}
                alt={coverAlt || title}
                className="absolute inset-0 h-full w-full object-cover"
                loading="eager"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/20 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-8 text-white">
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight drop-shadow">
                  {title}
                </h1>
                {description && (
                  <p className="mt-2 max-w-3xl text-sm sm:text-base text-white/90 drop-shadow">
                    {description}
                  </p>
                )}
                <MetaRow
                  date={date}
                  updated={updated}
                  readingMins={computedRT || readingTime}
                  author={author}
                  tags={tags}
                  dark
                />
              </div>
            </div>
          ) : (
            <div className="p-6 sm:p-8">
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight">{title}</h1>
              {description && <p className="mt-3 max-w-3xl text-lg text-gray-600">{description}</p>}
              <div className="mt-4">
                <MetaRow
                  date={date}
                  updated={updated}
                  readingMins={computedRT || readingTime}
                  author={author}
                  tags={tags}
                />
              </div>
            </div>
          )}

          {/* Utility bar */}
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 bg-white/60 px-4 py-3">
            <button className={cx(BTN, VAR.subtle)} onClick={toggleFavorite} aria-pressed={isFav}>
              {isFav ? <I.Heart className="h-4 w-4 text-rose-600" /> : <I.HeartOff className="h-4 w-4" />}
              <span>{isFav ? "Favorited" : "Favorite"}</span>
            </button>

            <button className={cx(BTN, VAR.ghost)} onClick={shareNative}>
              <I.Share className="h-4 w-4" />
              <span>Share</span>
            </button>

            <button className={cx(BTN, VAR.ghost)} onClick={copyLink}>
              <I.Link className="h-4 w-4" />
              <span>Copy link</span>
            </button>

            <button className={cx(BTN, VAR.ghost)} onClick={printPDF}>
              <I.Printer className="h-4 w-4" />
              <span>Print</span>
            </button>

            <button className={cx(BTN, VAR.ghost)} onClick={downloadJson}>
              <I.Download className="h-4 w-4" />
              <span>Export JSON</span>
            </button>

            {editUrl ? (
              <a href={editUrl} target="_blank" rel="noreferrer" className={cx(BTN, VAR.ghost)}>
                <I.ExternalLink className="h-4 w-4" />
                <span>Edit on GitHub</span>
              </a>
            ) : null}

            {/* Optional “Save as Plan” if frontmatter.plan is provided */}
            {planFromArticle ? (
              <button className={cx(BTN, VAR.primary, "ml-auto")} onClick={openSavePlan}>
                <I.BookmarkPlus className="h-4 w-4" />
                <span>Save as Plan</span>
              </button>
            ) : (
              <div className="ml-auto" />
            )}
          </div>
        </div>
      </header>

      {/* Main layout */}
      <main className={cx(WRAP, "grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-10 pb-16")}>
        {/* Article body */}
        <article id="article" ref={articleRef} className="min-w-0">
          <div className={cx(PROSE)}>{children}</div>

          {/* Optional embedded CTA for a plan */}
          {SystemCTA && planFromArticle && (
            <div className="mt-10">
              <div className="rounded-3xl border border-indigo-100 bg-indigo-50/50 p-4 sm:p-6">
                <div className="mb-3 flex items-center gap-2 text-indigo-800">
                  <I.Sparkles className="h-4 w-4" />
                  <span className="text-sm font-medium">Do something with this guide</span>
                </div>
                <SystemCTA domain={planFromArticle.domain || "meals"} plan={planFromArticle} />
              </div>
            </div>
          )}

          {/* Related */}
          {related?.length > 0 && (
            <section className="mt-12">
              <h2 className="text-lg font-semibold text-gray-900">Related articles</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {related.map((r, idx) => (
                  <a
                    key={idx}
                    href={r.href}
                    className="group overflow-hidden rounded-2xl border border-gray-200 bg-white hover:shadow-md transition"
                  >
                    {r.cover ? (
                      <div className="relative h-36 w-full">
                        <img src={r.cover} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                      </div>
                    ) : null}
                    <div className="p-4">
                      <h3 className="font-medium text-gray-900 group-hover:underline">{r.title}</h3>
                    </div>
                  </a>
                ))}
              </div>
            </section>
          )}
        </article>

        {/* Sidebar TOC */}
        <aside className="lg:sticky lg:top-20 h-max">
          <div className="rounded-3xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">On this page</h3>
              <button className={cx(BTN, VAR.ghost, "px-2 py-1")} onClick={() => setOpenTOC((v) => !v)}>
                <I.ChevronRight className={cx("h-4 w-4 transition", openTOC ? "rotate-90" : "")} />
              </button>
            </div>
            <nav className={cx("mt-3 space-y-1", !openTOC && "hidden lg:block")} aria-label="Table of contents">
              {toc.length === 0 ? (
                <p className="text-xs text-gray-500">No headings yet.</p>
              ) : (
                toc.map((h, i) => (
                  <a
                    key={i}
                    href={`#${h.id}`}
                    className={cx(
                      "block truncate rounded-lg px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50",
                      h.level === "h3" ? "pl-4 text-gray-600" : ""
                    )}
                  >
                    {h.text}
                  </a>
                ))
              )}
            </nav>
          </div>

          {/* NBA card (optional) */}
          {nbaHint && (
            <div className="mt-4 rounded-3xl border border-indigo-100 bg-indigo-50/60 p-4">
              <div className="flex items-start gap-2">
                <I.Star className="mt-0.5 h-4 w-4 text-indigo-700" />
                <div>
                  <p className="text-sm font-medium text-indigo-900">Next best action</p>
                  <p className="text-sm text-indigo-800/90">{nbaHint}</p>
                </div>
              </div>
              <button
                className={cx(BTN, VAR.primary, "mt-3 w-full justify-center")}
                onClick={() => eventBus.emit?.("nba.requested", { source: "ArticleLayout", articleId, domain })}
              >
                Do it
              </button>
            </div>
          )}
        </aside>
      </main>

      {/* Save as Plan modal (lazy preferred) */}
      {saveOpen && planFromArticle && (
        SavePlanModalLazy ? (
          <Suspense fallback={<InlineSaveFallback onClose={() => setSaveOpen(false)} />}>
            <SavePlanModalLazy
              isOpen={saveOpen}
              onClose={() => setSaveOpen(false)}
              defaultTitle={planFromArticle.title || title}
              domain={planFromArticle.domain || "meals"}
              plan={planFromArticle}
              onSaved={(saved) => {
                eventBus.emit?.("plan.saved", { from: "ArticleLayout", saved });
                toastSafe("Plan saved.");
                setSaveOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveAsPlan
            plan={planFromArticle}
            onCancel={() => setSaveOpen(false)}
            onSaved={(saved) => {
              eventBus.emit?.("plan.saved", { from: "ArticleLayout", saved });
              toastSafe("Plan saved.");
              setSaveOpen(false);
            }}
          />
        )
      )}

      {/* JSON-LD for SEO */}
      <ArticleJsonLD data={frontmatter} />
    </div>
  );
}

/* -------------------------------- Subcomponents ------------------------------ */
function MetaRow({ date, updated, readingMins, author, tags, dark = false }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {author?.avatar ? (
        <span className="inline-flex items-center gap-2">
          <img
            src={author.avatar}
            alt={author?.name || "Author"}
            className="h-6 w-6 rounded-full ring-2 ring-white/80"
          />
          {author?.name && <span className={cx("text-sm", dark ? "text-white/90" : "text-gray-700")}>{author.name}</span>}
          {author?.byline && <span className={cx("text-xs", dark ? "text-white/70" : "text-gray-500")}>{author.byline}</span>}
        </span>
      ) : null}

      {date ? (
        <span className={CHIP}>
          <I.Calendar className="h-3.5 w-3.5" />
          <time dateTime={new Date(date).toISOString()}>{fmt(date)}</time>
        </span>
      ) : null}

      {updated && updated !== date ? (
        <span className={CHIP}>
          <I.Calendar className="h-3.5 w-3.5" />
          <span>Updated {fmt(updated)}</span>
        </span>
      ) : null}

      <span className={CHIP}>
        <I.Clock className="h-3.5 w-3.5" />
        <span>{readingMins || 5} min read</span>
      </span>

      {asArray(tags).slice(0, 5).map((t, i) => (
        <span key={i} className={CHIP}>#{t}</span>
      ))}
    </div>
  );
}

function InlineSaveFallback({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div className="w-[95vw] max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-40 rounded bg-gray-200" />
          <div className="h-10 rounded bg-gray-100" />
          <div className="h-10 rounded bg-gray-100" />
        </div>
        <div className="mt-6 flex justify-end">
          <button className={cx(BTN, VAR.ghost)} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function InlineSaveAsPlan({ plan, onCancel, onSaved }) {
  const [name, setName] = useState(plan?.title || "");
  const [desc, setDesc] = useState(plan?.description || "");
  const [busy, setBusy] = useState(false);
  const domain = plan?.domain || "meals";

  const submit = async () => {
    setBusy(true);
    try {
      const payload = { ...plan, title: name, description: desc, domain };
      eventBus.emit?.("plan.save.requested", { payload, source: "ArticleLayout" });
      onSaved?.(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div className="w-[95vw] max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Save as Plan</h3>
        <p className="mt-1 text-sm text-gray-600">Save the embedded plan from this article to your library.</p>
        <label className="mt-4 block text-sm font-medium text-gray-700">Title</label>
        <input
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Plan title"
        />
        <label className="mt-4 block text-sm font-medium text-gray-700">Description</label>
        <textarea
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          rows={3}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What is this plan about?"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={onCancel}>Cancel</button>
          <button className={cx(BTN, VAR.primary)} onClick={submit} disabled={busy}>
            <I.BookOpen className="h-4 w-4" />
            Save Plan
          </button>
        </div>
      </div>
    </div>
  );
}
