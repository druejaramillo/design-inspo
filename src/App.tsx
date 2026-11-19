import { useDeferredValue, useEffect, useState, type DragEvent, type FormEvent } from "react";
import type { AnalysisProvider, CatalogIndex, CatalogItem, CatalogSummary, Taxonomy } from "../shared/schema";
import { publishedCatalogSchema, type PublishedCatalog, type PublishedCatalogItem } from "../shared/published-catalog";
import { buildCatalogContext, catalogItemTagIds, matchesCatalogTags } from "../shared/catalog-query";

const staticMode = import.meta.env.PROD;
const EMPTY_INDEX: Pick<PublishedCatalog, "generatedAt" | "items"> = { generatedAt: null, items: [] };
const EMPTY_TAXONOMY: Taxonomy = { groups: [] };

async function api<T>(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Something went wrong.");
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

function mediaUrl(item: Pick<CatalogSummary, "media">, staticMode = false) {
  return item.media ? `${staticMode ? "/catalog/media" : "/media"}/${item.media.path.split("/").pop()}` : null;
}

function fallbackGradient(item: PublishedCatalogItem) {
  const colors = item.analysis?.palette.map((color) => color.hex) ?? [];
  if (colors.length >= 2) return `linear-gradient(142deg, ${colors[0]}, ${colors[1]} 55%, ${colors[2] ?? colors[0]})`;
  const seed = item.id.charCodeAt(0) % 4;
  return [
    "linear-gradient(145deg, #e8ffcc, #b1d04c 54%, #183e2f)",
    "linear-gradient(145deg, #ffbd7a, #ef5f3c 55%, #421616)",
    "linear-gradient(145deg, #b4c4ff, #6655df 55%, #171c4d)",
    "linear-gradient(145deg, #eee5da, #b69b79 54%, #38312c)",
  ][seed];
}

function displayStatus(status: CatalogSummary["analysisStatus"]) {
  return {
    pending: "Needs analysis",
    ready: "Analyzed",
    failed: "Analysis failed",
    canceled: "Analysis canceled",
    "not-requested": "Needs image",
  }[status];
}

export default function App() {
  const [catalog, setCatalog] = useState(EMPTY_INDEX);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(EMPTY_TAXONOMY);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [filterMode, setFilterMode] = useState<"and" | "or">("and");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selected, setSelected] = useState<CatalogItem | PublishedCatalogItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [cancelingAnalysis, setCancelingAnalysis] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (staticMode) {
      const snapshot = publishedCatalogSchema.parse(await api<unknown>("/catalog/catalog.json"));
      setCatalog(snapshot);
      setTaxonomy(snapshot.taxonomy);
      return;
    }
    const [nextCatalog, nextTaxonomy] = await Promise.all([api<CatalogIndex>("/api/catalog"), api<Taxonomy>("/api/taxonomy")]);
    setCatalog(nextCatalog);
    setTaxonomy(nextTaxonomy);
  }

  useEffect(() => {
    refresh().catch((nextError: Error) => setError(nextError.message));
  }, []);

  useEffect(() => {
    if (!analysisStartedAt) {
      setAnalysisElapsed(0);
      return;
    }
    const updateElapsed = () => setAnalysisElapsed(Math.floor((Date.now() - analysisStartedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [analysisStartedAt]);

  const context = buildCatalogContext(catalog.items, activeTags, filterMode, window.location.origin);
  const tagLabels = Object.fromEntries(taxonomy.groups.flatMap((group) => group.tags.map((tag) => [tag.id, tag.label])));
  const filteredItems = catalog.items.filter((item) => {
    const itemTags = catalogItemTagIds(item);
    const tagMatches = matchesCatalogTags(item, activeTags, filterMode);
    const term = deferredSearch.trim().toLowerCase();
    const searchMatches = !term || [item.title, item.sourceDomain, ...itemTags.map((tag) => tagLabels[tag] ?? tag)].filter(Boolean).join(" ").toLowerCase().includes(term);
    return tagMatches && searchMatches;
  });

  function toggleTag(tagId: string) {
    setActiveTags((tags) => (tags.includes(tagId) ? tags.filter((tag) => tag !== tagId) : [...tags, tagId]));
  }

  async function openItem(id: string) {
    try {
      setBusy(`open-${id}`);
      const item = staticMode ? catalog.items.find((candidate) => candidate.id === id) : await api<CatalogItem>(`/api/items/${id}`);
      if (!item) throw new Error("Could not find this published catalog item.");
      setSelected(item);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not open this inspiration.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshSelected(id: string) {
    const item = await api<CatalogItem>(`/api/items/${id}`);
    setSelected(item);
    await refresh();
    return item;
  }

  function pullUrl(event: DragEvent<HTMLElement>) {
    return event.dataTransfer.getData("text/uri-list").split("\n").find((value) => value && !value.startsWith("#")) || event.dataTransfer.getData("text/plain");
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropActive(false);
    if (staticMode) return;
    const [droppedFile] = Array.from(event.dataTransfer.files);
    const droppedUrl = pullUrl(event);
    if (droppedFile) {
      setFile(droppedFile);
      setUrl("");
      setTitle(droppedFile.name.replace(/\.[^.]+$/, ""));
      setImportOpen(true);
    } else if (/^https?:\/\//i.test(droppedUrl)) {
      setUrl(droppedUrl);
      setFile(null);
      setImportOpen(true);
    } else {
      setError("Drop an image file or a public http(s) link.");
    }
  }

  async function submitImport(event: FormEvent) {
    event.preventDefault();
    if (staticMode) return;
    if (!file && !url.trim()) {
      setError("Choose an image or enter a public URL.");
      return;
    }
    try {
      setBusy("import");
      setError(null);
      const body = new FormData();
      if (file) body.append("file", file);
      if (url.trim()) body.append("url", url.trim());
      if (title.trim()) body.append("title", title.trim());
      const result = await api<{ item: CatalogItem; message: string }>("/api/import", { method: "POST", body });
      await refresh();
      setSelected(result.item);
      setNotice(result.message);
      setImportOpen(false);
      setFile(null);
      setUrl("");
      setTitle("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveSelected(patch: Partial<Pick<CatalogItem, "title" | "notes" | "manualTagIds" | "sourceUrl">>) {
    if (!selected || staticMode) return;
    try {
      setBusy("save-item");
      const updated = await api<CatalogItem>(`/api/items/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      setSelected(updated);
      await refresh();
      setNotice("Saved to the catalog.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save changes.");
    } finally {
      setBusy(null);
    }
  }

  async function analyze(provider: AnalysisProvider) {
    if (!selected || staticMode) return;
    const id = selected.id;
    try {
      setBusy(`analyze-${provider}`);
      setAnalysisStartedAt(Date.now());
      setCancelingAnalysis(false);
      setError(null);
      const updated = await api<CatalogItem>(`/api/items/${id}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      setSelected(updated);
      await refresh();
      setNotice(`Analysis completed with ${provider === "pi" ? "Pi" : "OpenAI"}.`);
    } catch (nextError) {
      try {
        const updated = await refreshSelected(id);
        if (!updated.analysisError) setError(nextError instanceof Error ? nextError.message : "Analysis failed.");
      } catch {
        setError(nextError instanceof Error ? nextError.message : "Analysis failed.");
      }
    } finally {
      setBusy(null);
      setAnalysisStartedAt(null);
      setCancelingAnalysis(false);
    }
  }

  async function cancelAnalysis() {
    if (!selected || staticMode) return;
    try {
      setCancelingAnalysis(true);
      await api<{ message: string }>(`/api/items/${selected.id}/analyze`, { method: "DELETE" });
      setNotice("Cancel requested. Saving the final status...");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not cancel analysis.");
      setCancelingAnalysis(false);
    }
  }

  async function removeSelected() {
    if (!selected || staticMode || !window.confirm(`Delete '${selected.title}' from this local catalog?`)) return;
    try {
      setBusy("delete-item");
      await api<void>(`/api/items/${selected.id}`, { method: "DELETE" });
      setSelected(null);
      await refresh();
      setNotice("Inspiration deleted.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not delete this item.");
    } finally {
      setBusy(null);
    }
  }

  async function copyContext() {
    if (!context.count) return;
    await navigator.clipboard.writeText(context.prompt);
    setNotice("Direction copied. Paste it into Pi with the relevant task.");
  }

  return (
    <main
      className={dropActive ? "app is-dropping" : "app"}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!staticMode) setDropActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Field Notes home">
          <span>FIELD</span>
          <span>NOTES</span>
        </a>
        <div className="topbar-center">A personal reference shelf for things worth looking at twice.</div>
        {staticMode ? <p className="catalog-mode">Read-only catalog</p> : <button className="add-button" type="button" onClick={() => setImportOpen(true)}>
          <span>+</span> Add reference
        </button>}
      </header>

      {(notice || error) && (
        <div className={error ? "message error-message" : "message"} role={error ? "alert" : "status"}>
          <span>{error || notice}</span>
          <button type="button" onClick={() => {
            setNotice(null);
            setError(null);
          }} aria-label="Dismiss message">x</button>
        </div>
      )}

      <section className="intro">
        <p className="eyebrow">PERSONAL DESIGN ARCHIVE / {catalog.items.length.toString().padStart(3, "0")} REFERENCES</p>
        <h1>Collect the odd,<br />useful, and <em>alive.</em></h1>
        <p className="intro-copy">{staticMode ? "Explore saved references, filter by visual language, and pull a direction for your next design." : "Drag a design in, label its visual DNA, then pull a direction when the next blank canvas arrives."}</p>
        {!staticMode && <button className="drop-hint" type="button" onClick={() => setImportOpen(true)}>Drop an image or link anywhere</button>}
      </section>

      <section className="workbench" aria-label="Catalog browser">
        <aside className="filter-rail">
          <div className="filter-title-row">
            <h2>Read the shelf</h2>
            {activeTags.length > 0 && <button className="text-button" type="button" onClick={() => setActiveTags([])}>Clear</button>}
          </div>
          <div className="mode-switch" aria-label="Tag matching mode">
            <button className={filterMode === "and" ? "active" : ""} type="button" onClick={() => setFilterMode("and")}>All of</button>
            <button className={filterMode === "or" ? "active" : ""} type="button" onClick={() => setFilterMode("or")}>Any of</button>
          </div>
          {taxonomy.groups.map((group) => (
            <section className="tag-group" key={group.id}>
              <h3>{group.label}</h3>
              <div className="tag-list">
                {group.tags.map((tag) => (
                  <button
                    className={activeTags.includes(tag.id) ? "tag active" : "tag"}
                    type="button"
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </aside>

        <div className="gallery-zone">
          <div className="gallery-toolbar">
            <label className="search-field">
              <span>Search</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="titles, tags, sources" />
            </label>
            <p>{filteredItems.length} {filteredItems.length === 1 ? "reference" : "references"} in view</p>
          </div>
          {filteredItems.length ? (
            <div className="card-grid">
              {filteredItems.map((item, index) => (
                <article className={index % 7 === 0 ? "reference-card card-wide" : "reference-card"} key={item.id}>
                  <button className="card-image" type="button" onClick={() => openItem(item.id)} aria-label={`Open ${item.title}`}>
                    {mediaUrl(item, staticMode) ? <img src={mediaUrl(item, staticMode)!} alt="" /> : <div className="image-fallback" style={{ background: fallbackGradient(item) }}><span>Needs image</span></div>}
                    <span className="status-label">{displayStatus(item.analysisStatus)}</span>
                  </button>
                  <div className="card-meta">
                    <div>
                      <p className="source-name">{item.sourceDomain || "Local upload"}</p>
                      <h2>{item.title}</h2>
                    </div>
                    <button className="open-button" type="button" onClick={() => openItem(item.id)} disabled={busy === `open-${item.id}`}>View</button>
                  </div>
                  <div className="card-tags">
                    {catalogItemTagIds(item).slice(0, 4).map((tag) => <span key={tag}>{tagLabels[tag] ?? tag}</span>)}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-shelf">
              <p className="eyebrow">THE SHELF IS OPEN</p>
              <h2>{catalog.items.length ? "No references meet this direction." : staticMode ? "No references have been published yet." : "Start with something that catches."}</h2>
              <p>{catalog.items.length ? "Try removing a tag, switching to Any of, or searching less specifically." : staticMode ? "References appear here after the local catalog is published." : "Drag in a screenshot, image file, or a public page link. Every reference remains local and easy to commit."}</p>
              {!staticMode && <button className="add-button" type="button" onClick={() => setImportOpen(true)}><span>+</span> Add the first one</button>}
            </div>
          )}
        </div>

        <aside className="direction-panel">
          <p className="eyebrow">DIRECTION GENERATOR</p>
          <h2>{activeTags.length ? activeTags.map((tag) => tagLabels[tag] ?? tag).join(" + ") : "Current shelf"}</h2>
          <p className="direction-count">{context?.count ?? 0} matching references</p>
          <div className="prompt-card">
            <p>{context?.prompt || "Choose some tags to turn this collection into a usable visual direction."}</p>
          </div>
          <button className="copy-button" type="button" onClick={copyContext} disabled={!context?.count}>Copy direction</button>
          <div className="direction-references">
            {(context?.references ?? []).map((reference) => (
              <button type="button" key={reference.id} onClick={() => openItem(reference.id)}>
                <span>{reference.title}</span>
                <small>{reference.sourceUrl ? "source" : "local"}</small>
              </button>
            ))}
          </div>
          <p className="connection-hint">{staticMode ? <>Connect an agent at <code>/mcp</code>, or <a href="/api/overview">browse the read-only API</a>.</> : "Changes stay in this repository until you commit, push, and publish."}</p>
        </aside>
      </section>

      {!staticMode && dropActive && <div className="drop-overlay"><div><span>+</span><p>Release to add this reference</p><small>Images and public links are both welcome.</small></div></div>}

      {!staticMode && importOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setImportOpen(false)}>
          <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-heading" onMouseDown={(event) => event.stopPropagation()}>
            <button className="close-button" type="button" onClick={() => setImportOpen(false)} aria-label="Close import">x</button>
            <p className="eyebrow">NEW FIELD NOTE</p>
            <h2 id="import-heading">Bring in a reference.</h2>
            <p>Drop a file anywhere on the page, pick one below, or give us the page it came from.</p>
            <form onSubmit={submitImport}>
              <label className={file ? "file-pick has-file" : "file-pick"}>
                <input type="file" accept="image/*" onChange={(event) => {
                  const nextFile = event.target.files?.[0] ?? null;
                  setFile(nextFile);
                  if (nextFile) {
                    setUrl("");
                    if (!title) setTitle(nextFile.name.replace(/\.[^.]+$/, ""));
                  }
                }} />
                <span>{file ? file.name : "Choose an image file"}</span>
                <small>{file ? `${Math.round(file.size / 1024)} KB ready to save` : "PNG, JPG, WebP, AVIF and screenshots"}</small>
              </label>
              <div className="form-divider"><span>or</span></div>
              <label className="form-field">Source URL
                <input type="url" placeholder="https://..." value={url} onChange={(event) => {
                  setUrl(event.target.value);
                  if (event.target.value) setFile(null);
                }} />
              </label>
              <label className="form-field">Title <span>(optional)</span>
                <input type="text" placeholder="Give it a memorable name" value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <button className="submit-import" type="submit" disabled={busy === "import"}>{busy === "import" ? "Saving..." : "Save to the shelf"}</button>
            </form>
            <p className="modal-footnote">For a page URL, Field Notes reads public preview metadata only. If a site blocks it, the source still saves and you can add a screenshot later.</p>
          </section>
        </div>
      )}

      {selected && (
        <div className="modal-backdrop detail-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
          <section className="detail-modal" role="dialog" aria-modal="true" aria-label={selected.title} onMouseDown={(event) => event.stopPropagation()}>
            <button className="close-button" type="button" onClick={() => setSelected(null)} aria-label="Close details">x</button>
            <div className="detail-image" style={!mediaUrl(selected, staticMode) ? { background: fallbackGradient(selected) } : undefined}>
              {mediaUrl(selected, staticMode) ? <img src={mediaUrl(selected, staticMode)!} alt={selected.title} /> : <span>No image saved yet</span>}
            </div>
            <div className="detail-content">
              <p className="eyebrow">{selected.sourceDomain || "LOCAL REFERENCE"}</p>
              {staticMode ? <h2 className="detail-title">{selected.title}</h2> : <input aria-label="Reference title" className="detail-title" value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} onBlur={() => saveSelected({ title: selected.title })} />}
              {selected.sourceUrl && <a className="source-link" href={selected.sourceUrl} target="_blank" rel="noreferrer">Open original source</a>}
              <section className="detail-section">
                <div className="section-heading"><h3>Tags</h3><span>{staticMode ? "From the catalog" : "Curated by you"}</span></div>
                <div className="tag-list editable-tags">
                  {staticMode ? catalogItemTagIds(selected).map((tag) => <span className="tag active" key={tag}>{tagLabels[tag] ?? tag}</span>) : taxonomy.groups.flatMap((group) => group.tags).map((tag) => {
                    const active = selected.manualTagIds.includes(tag.id);
                    return <button className={active ? "tag active" : "tag"} type="button" key={tag.id} disabled={staticMode} onClick={() => saveSelected({ manualTagIds: active ? selected.manualTagIds.filter((id) => id !== tag.id) : [...selected.manualTagIds, tag.id] })}>{tag.label}</button>;
                  })}
                </div>
              </section>
              {!staticMode && "notes" in selected && <section className="detail-section">
                <div className="section-heading"><h3>Notes</h3><span>Local only</span></div>
                <textarea aria-label="Local notes" value={selected.notes} placeholder="Why did this one make the cut?" onChange={(event) => setSelected({ ...selected, notes: event.target.value })} onBlur={() => saveSelected({ notes: selected.notes })} />
              </section>}
              <section className="analysis-section">
                <div className="section-heading"><h3>Visual reading</h3><span>{displayStatus(selected.analysisStatus)}</span></div>
                {!staticMode && "analysisError" in selected && selected.analysisError && <p className="analysis-feedback" role="alert">{selected.analysisError}</p>}
                {analysisStartedAt && <div className="analysis-progress" role="status">
                  <span>Reading with {busy === "analyze-pi" ? "Pi" : "OpenAI"}... {analysisElapsed}s</span>
                  <button type="button" onClick={cancelAnalysis} disabled={cancelingAnalysis}>{cancelingAnalysis ? "Canceling..." : "Cancel"}</button>
                </div>}
                {selected.analysis ? <AnalysisDisplay analysis={selected.analysis} tagLabels={tagLabels} /> : <p className="analysis-empty">{staticMode ? "No visual reading has been saved for this reference." : "Run a vision pass to pull out palette, typography, layout, tone, and an original hero-image prompt."}</p>}
                {selected.media && !staticMode && <div className="analysis-actions">
                  <button type="button" className="analysis-button" onClick={() => analyze("pi")} disabled={busy?.startsWith("analyze")}>{busy === "analyze-pi" ? "Reading image..." : selected.analysis ? "Reanalyze with Pi" : selected.analysisStatus === "failed" || selected.analysisStatus === "canceled" ? "Retry with Pi" : "Analyze with Pi"}</button>
                  <button type="button" className="text-button" onClick={() => analyze("openai")} disabled={busy?.startsWith("analyze")}>{busy === "analyze-openai" ? "Reading image..." : "Use OpenAI"}</button>
                </div>}
              </section>
              {!staticMode && <button className="delete-button" type="button" onClick={removeSelected} disabled={busy === "delete-item"}>{busy === "delete-item" ? "Deleting..." : "Delete reference"}</button>}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function AnalysisDisplay({ analysis, tagLabels }: { analysis: NonNullable<CatalogItem["analysis"]>; tagLabels: Record<string, string> }) {
  return (
    <div className="analysis-results">
      <div className="palette-row">{analysis.palette.map((color) => <span key={`${color.hex}-${color.role}`} title={`${color.role}: ${color.hex}`} style={{ backgroundColor: color.hex }} />)}</div>
      <p>{analysis.notes}</p>
      <div className="analysis-lists">
        <p><strong>Style</strong>{analysis.style.join(" / ")}</p>
        <p><strong>Tone</strong>{analysis.tone.join(" / ")}</p>
        <p><strong>Layout</strong>{analysis.layout.join(" / ")}</p>
        <p><strong>Type</strong>{analysis.typography.join(" / ")}</p>
      </div>
      {analysis.suggestedTagIds.length > 0 && <div className="suggested-tags">{analysis.suggestedTagIds.map((tag) => <span key={tag}>{tagLabels[tag] ?? tag}</span>)}</div>}
      {analysis.heroPrompt && <div className="hero-prompt"><strong>Hero image prompt</strong><p>{analysis.heroPrompt}</p></div>}
    </div>
  );
}
