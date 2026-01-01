import React, { useEffect, useRef, useState, useMemo } from "react";

/**
 * FloatingAutomationPanel
 * - Listens for:
 *     • `ui.automation.panel.show`  { sessionId }
 *     • `animals.session.draft|scheduled|run.start|run.finish`
 * - Can be opened imperatively:  window.dispatchEvent(new CustomEvent('ui.automation.panel.show', { detail:{ sessionId } }))
 * - Draggable, minimizable, sticky across navigations via localStorage
 */
export default function FloatingAutomationPanel() {
  const [visible, setVisible] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("automation.panel.pos")) || { x: 24, y: 24 };
    } catch { return { x: 24, y: 24 }; }
  });

  const [session, setSession] = useState(null);
  const [running, setRunning] = useState(false);
  const [activeTaskIndex, setActiveTaskIndex] = useState(0);
  const dragRef = useRef(null);
  const panelRef = useRef(null);

  // helpers exposed by window.__suka if present
  const api = useMemo(() => {
    const suka = window.__suka || {};
    return {
      bus: suka.eventBus,
      db: suka.db, // optional Dexie facade
      runtime: suka.automationRuntime, // optional bridge to your automation runtime
      routes: suka.routes || {
        meal: "/tier2/household/meals",
        cleaning: "/tier2/household/cleaning",
        garden: "/tier2/household/garden",
        animals: "/tier2/household/animals",
        inventory: "/tier2/household/inventory",
      },
    };
  }, []);

  // listen for open requests + engine events
  useEffect(() => {
    const onShow = (e) => {
      if (e?.detail?.session) {
        setSession(e.detail.session);
        setActiveTaskIndex(0);
        setVisible(true);
        setMinimized(false);
      } else if (e?.detail?.sessionId && api.db?.sessions?.get) {
        api.db.sessions.get(e.detail.sessionId).then((doc) => {
          if (doc) {
            setSession(doc);
            setActiveTaskIndex(0);
            setVisible(true);
            setMinimized(false);
          }
        });
      } else {
        setVisible(true);
        setMinimized(false);
      }
    };

    const onDraft = (e) => setSession(e.detail?.session || e.detail);
    const onScheduled = (e) => setSession(e.detail?.session || e.detail);
    const onRunStart = () => setRunning(true);
    const onRunFinish = () => setRunning(false);

    window.addEventListener("ui.automation.panel.show", onShow);
    window.addEventListener("animals.session.draft", onDraft);
    window.addEventListener("animals.session.scheduled", onScheduled);
    window.addEventListener("animals.session.run.start", onRunStart);
    window.addEventListener("animals.session.run.finish", onRunFinish);
    return () => {
      window.removeEventListener("ui.automation.panel.show", onShow);
      window.removeEventListener("animals.session.draft", onDraft);
      window.removeEventListener("animals.session.scheduled", onScheduled);
      window.removeEventListener("animals.session.run.start", onRunStart);
      window.removeEventListener("animals.session.run.finish", onRunFinish);
    };
  }, [api.db]);

  // drag
  useEffect(() => {
    const node = dragRef.current;
    const panel = panelRef.current;
    if (!node || !panel) return;

    let sx=0, sy=0, px=pos.x, py=pos.y, dragging=false;

    const md = (e) => { dragging = true; sx = e.clientX; sy = e.clientY; e.preventDefault(); };
    const mm = (e) => {
      if (!dragging) return;
      const nx = px + (e.clientX - sx);
      const ny = py + (e.clientY - sy);
      setPos({ x: nx, y: ny });
      panel.style.transform = `translate(${nx}px, ${ny}px)`;
    };
    const mu = () => {
      if (!dragging) return;
      dragging = false;
      px = pos.x; py = pos.y;
      localStorage.setItem("automation.panel.pos", JSON.stringify({ x: px, y: py }));
    };

    node.addEventListener("mousedown", md);
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    // initial
    panel.style.transform = `translate(${pos.x}px, ${pos.y}px)`;

    return () => {
      node.removeEventListener("mousedown", md);
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
    };
  }, [pos.x, pos.y]);

  if (!visible) return null;

  const tasks = session?.tasks || [];
  const active = tasks[activeTaskIndex];

  const setDone = async (idx, done=true) => {
    const next = { ...(session||{}), tasks: [...tasks] };
    next.tasks[idx] = { ...next.tasks[idx], done };
    setSession(next);
    // persist optimistically if db present
    try { await api.db?.sessions?.put(next); } catch {}
    window.dispatchEvent(new CustomEvent("animals.session.task.updated", { detail: { session: next, task: next.tasks[idx], index: idx } }));
  };

  const startResume = async () => {
    setRunning(true);
    window.dispatchEvent(new CustomEvent("animals.session.run.start", { detail: { sessionId: session?.id } }));
    await api.runtime?.runOnce?.({ type: "animals.session.run", sessionId: session?.id });
  };

  const pause = () => {
    setRunning(false);
    window.dispatchEvent(new CustomEvent("animals.session.run.pause", { detail: { sessionId: session?.id } }));
  };

  const nextTask = () => setActiveTaskIndex((i) => Math.min(i + 1, tasks.length - 1));
  const prevTask = () => setActiveTaskIndex((i) => Math.max(i - 1, 0));

  const open = (route) => {
    try {
      window.history.pushState({}, "", route);
      window.dispatchEvent(new Event("popstate"));
    } catch {
      window.location.href = route;
    }
  };

  return (
    <div
      ref={panelRef}
      className="fixed z-[9999] pointer-events-auto"
      style={{ left: 0, top: 0 }}
      aria-live="polite"
    >
      <div className="w-[340px] rounded-2xl shadow-xl border border-neutral-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div ref={dragRef} className="cursor-move px-3 py-2 rounded-t-2xl bg-neutral-100 border-b flex items-center justify-between">
          <div className="text-sm font-semibold truncate">Animals • {session?.title || "Session"}</div>
          <div className="flex items-center gap-1">
            <button className="btn btn-xs" onClick={() => setMinimized((m) => !m)}>{minimized ? "▢" : "—"}</button>
            <button className="btn btn-xs" onClick={() => setVisible(false)}>✕</button>
          </div>
        </div>

        {!minimized && (
          <div className="p-3 space-y-3">
            {/* status */}
            <div className="flex items-center justify-between">
              <div className={`chip ${running ? "chip-success" : "chip-warning"}`}>
                {running ? "Running" : "Idle"}
              </div>
              <div className="text-xs text-neutral-500">{tasks.filter(t=>t.done).length}/{tasks.length} done</div>
            </div>

            {/* active task */}
            {active ? (
              <div className="card p-3">
                <div className="text-sm font-semibold mb-1">{active.title}</div>
                <div className="text-xs text-neutral-500 mb-2">
                  {active.species} • {active.type} • ~{active.estMinutes} min
                </div>
                <div className="flex gap-2">
                  {!active.done ? (
                    <button className="btn btn-primary btn-sm" onClick={() => setDone(activeTaskIndex, true)}>Mark Done</button>
                  ) : (
                    <button className="btn btn-outline btn-sm" onClick={() => setDone(activeTaskIndex, false)}>Undo</button>
                  )}
                  <button className="btn btn-sm" onClick={prevTask} disabled={activeTaskIndex===0}>Prev</button>
                  <button className="btn btn-sm" onClick={nextTask} disabled={activeTaskIndex===tasks.length-1}>Next</button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-neutral-500">No tasks.</div>
            )}

            {/* controls */}
            <div className="flex gap-2">
              {!running ? (
                <button className="btn btn-primary btn-sm w-full" onClick={startResume}>Start / Resume</button>
              ) : (
                <button className="btn btn-warning btn-sm w-full" onClick={pause}>Pause</button>
              )}
            </div>

            {/* quick navigation */}
            <div className="grid grid-cols-2 gap-2">
              <button className="btn btn-ghost btn-sm" onClick={() => open(api.routes.meal)}>Meal Planner</button>
              <button className="btn btn-ghost btn-sm" onClick={() => open(api.routes.cleaning)}>Cleaning</button>
              <button className="btn btn-ghost btn-sm" onClick={() => open(api.routes.garden)}>Garden</button>
              <button className="btn btn-ghost btn-sm" onClick={() => open(api.routes.inventory)}>Inventory</button>
              <button className="btn btn-ghost btn-sm col-span-2" onClick={() => open(api.routes.animals)}>Animals</button>
            </div>

            {/* session summary */}
            <div className="text-xs text-neutral-500">
              {session?.tasks?.length ? (
                <span>
                  Top tasks: {session.tasks.slice(0,3).map(t=>t.title).join(" • ")} • ~{Math.round((session.estMinutes||60)/5)*5} min total
                </span>
              ) : "—"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
