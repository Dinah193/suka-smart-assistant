// src/pages/cooking/views/CookNowFlow.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { classNames as cx } from "@/utils/css";
import { I } from "@/components/icons/SafeIcon"; // use <I> for icons safely

// Optional stores (graceful fallback)
import { useFoodStore } from "@/store/FoodStore";
import { useInventoryStore } from "@/store/InventoryStore";
import { useCalendarStore } from "@/store/CalendarStore.js";

/* ------------------ tiny UI atoms (DaisyUI/Tailwind) ------------------ */
const Card = ({ title, subtitle, right, children }) => (
  <div className="rounded-2xl shadow-md border border-base-200 bg-base-100">
    <div className="flex items-start justify-between p-5 border-b border-base-200">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle && <p className="text-sm opacity-70 mt-1">{subtitle}</p>}
      </div>
      {right}
    </div>
    <div className="p-5">{children}</div>
  </div>
);

const Button = (p) => <button {...p} className={cx("btn", p.className)} />;
const Primary = (p) => <Button {...p} className={cx("btn-primary", p.className)} />;
const Subtle  = (p) => <Button {...p} className={cx("btn-outline", p.className)} />;
const Ghost   = (p) => <Button {...p} className={cx("btn-ghost", p.className)} />;
const Danger  = (p) => <Button {...p} className={cx("btn-error", p.className)} />;
const Pill = ({ active, children, onClick }) => (
  <button onClick={onClick}
    className={cx("px-3 py-1 rounded-full text-sm border", active ? "bg-primary text-primary-content border-primary" : "bg-base-100 border-base-300")}>
    {children}
  </button>
);
const Notice = ({ tone="info", children }) => {
  const t = tone==="success"?"alert-success":tone==="warning"?"alert-warning":tone==="error"?"alert-error":"alert-info";
  return <div className={cx("alert", t)}>{children}</div>;
};
const Skeleton = ({ lines=3 }) => (
  <div className="animate-pulse space-y-3">{Array.from({length:lines}).map((_,i)=><div key={i} className="h-4 bg-base-200 rounded" />)}</div>
);

/* --------------------------- helpers & hooks --------------------------- */
function useUndo() {
  const stack = useRef([]);
  const push = (revert, descr="Change") => {
    stack.current.push(revert);
    return { undo: () => stack.current.pop()?.(), descr };
  };
  return { push };
}

const EVENTS = ["recipe.consolidated","inventory.updated","calendar.synced","preferences.changed","torah.profile.updated"];
function useGlue(onEvent) {
  useEffect(()=> {
    const offs=[];
    EVENTS.forEach(k => {
      const off = automation?.on?.(k, (payload)=>onEvent?.(k,payload));
      if (off) offs.push(off);
    });
    return ()=>offs.forEach(f=>f?.());
  },[onEvent]);
}

const demoQuick = [
  { id:"quick-15", label:"15 min", target:15 },
  { id:"quick-30", label:"30 min", target:30 },
  { id:"quick-45", label:"45 min", target:45 },
];

/* ------------------------------ main view ------------------------------ */
export default function CookNowFlow() {
  const food = useFoodStore?.() ?? {};
  const inv = useInventoryStore?.() ?? {};
  const cal = useCalendarStore?.() ?? {};

  const [loading, setLoading] = useState(false);
  const [banners, setBanners] = useState([]);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState(demoQuick[1]); // default 30 min
  const [pantryFirst, setPantryFirst] = useState(true);
  const [servings, setServings] = useState(4);

  // session state
  const [session, setSession] = useState(null); // {id, title, steps:[{id,text,duration,done}], timers:[...]}
  const [stepIdx, setStepIdx] = useState(0);
  const timersRef = useRef({}); // id -> timeout

  const undo = useUndo();

  /* --------------------------- event-driven glue -------------------------- */
  useGlue((event, payload) => {
    if (event==="recipe.consolidated") addBanner({ key:"recs", tone:"info", text:"Recipes changed—refresh your quick picks.", actions:[{label:"Refresh", fn:()=>prefetchQuick() }]});
    if (event==="inventory.updated") addBanner({ key:"inv", tone:"warning", text:"Inventory updated—your substitutes may change.", actions:[{label:"Review subs", fn:()=>openSubs()}]});
    if (event==="calendar.synced") addBanner({ key:"cal", tone:"success", text:"Calendar sync complete.", dismissible:true });
    if (event==="preferences.changed") setToast({ tone:"info", text:"Preferences applied to cooking suggestions." });
    if (event==="torah.profile.updated") addBanner({ key:"diet", tone:"info", text:"Dietary profile changed—rebuild picks.", actions:[{label:"Rebuild", fn:()=>prefetchQuick()}]});
  });
  const addBanner = (b) => setBanners(prev => prev.find(x=>x.key===b.key)?prev:[...prev,b]);
  const dismissBanner = (k) => setBanners(prev => prev.filter(b=>b.key!==k));

  /* ------------------------------- actions -------------------------------- */
  const prefetchQuick = async () => {
    setLoading(true);
    try {
      // try store fallback → automation
      await (food.prefetchQuick ? food.prefetchQuick() : automation.request?.("food.prefetchQuick", { preset: preset?.target, pantryFirst, servings }));
    } finally {
      setLoading(false);
    }
  };

  const startSession = async () => {
    setBusy(true);
    try {
      // Generate a tiny merged timeline on the fly (store or runtime)
      const s = await (food.generate
        ? food.generate("quick-now", { minutes: preset.target, pantryFirst, servings })
        : automation.request?.("food.generate", { scope:"quick-now", minutes:preset.target, pantryFirst, servings })) ;

      // Fallback demo when backend not wired:
      const fallback = {
        id: Date.now(),
        title: `Cook Now (${preset.label})`,
        steps: [
          { id:"preheat", text:"Preheat oven to 425°F", duration:0 },
          { id:"chop", text:"Chop onions and peppers", duration:5 },
          { id:"sauté", text:"Sauté veggies 6 min", duration:6 },
          { id:"protein", text:"Season protein; sear 3 min each side", duration:6 },
          { id:"finish", text:"Combine & finish 8 min in oven", duration:8 },
          { id:"plate", text:"Rest 3 min, plate & garnish", duration:3 },
        ],
      };
      setSession(s ?? fallback);
      setStepIdx(0);
      setToast(null);
    } catch {
      setToast({ tone:"error", text:"Couldn’t start session." });
    } finally {
      setBusy(false);
    }
  };

  const step = session?.steps?.[stepIdx];
  const next = () => setStepIdx((i)=>Math.min(i+1, (session?.steps?.length||1)-1));
  const prev = () => setStepIdx((i)=>Math.max(0, i-1));

  const setTimer = (min=5) => {
    const id = `t-${Date.now()}`;
    const tid = setTimeout(()=>{
      setToast({ tone:"success", text:`${min}-minute timer done` });
      delete timersRef.current[id];
    }, min*60*1000);
    timersRef.current[id] = tid;
    const { undo: revert } = undo.push(()=>{ clearTimeout(tid); delete timersRef.current[id]; }, "Start timer");
    setToast({ tone:"info", text:`Timer started for ${min} min`, action:{ label:"Undo", fn:revert }});
  };

  const completeSession = async () => {
    const task = async () => {
      setBusy(true);
      try {
        // Example: deduct likely items & sync cleanup (all undoable)
        const invBefore = inv.snapshot?.();
        await (inv.consumeForLastCook
          ? inv.consumeForLastCook()
          : automation.request?.("inventory.consume.estimated", { servings }));

        const { undo: revertInv } = undo.push(async ()=>{
          if (inv.restoreSnapshot) await inv.restoreSnapshot(invBefore);
          else await automation.request?.("inventory.restoreSnapshot", { snapshot: invBefore });
        }, "Inventory deduction");

        await (cal.createCleanupEvent
          ? cal.createCleanupEvent({ minutes: 5 })
          : automation.request?.("calendar.add.cleanup", { minutes:5 }));

        const { undo: revertCal } = undo.push(async ()=>{
          await (cal.undoLastEvent ? cal.undoLastEvent() : automation.request?.("calendar.undoLastEvent"));
        }, "Cleanup event");

        setToast({
          tone:"success",
          text:"Nice! Dinner done.",
          action:{ label:"Undo all", fn: async ()=>{ revertCal(); revertInv(); } }
        });

        emitProgress?.("cooking.session.completed", {
          id: session?.id, minutes: preset?.target,
          nextBestAction: { label:"Create leftover labels", action:"leftovers.labels" }
        });
      } catch {
        setToast({ tone:"error", text:"Couldn’t wrap up. Try again." });
      } finally {
        setBusy(false);
      }
    };
    await sabbathGuard(task, { allowReadOnly:false });
  };

  const openSubs = () => automation.emit?.("ui.navigate", { to:"/storehouse/substitutions" });

  /* ------------------------------- hotkeys -------------------------------- */
  useEffect(()=>{
    const onKey=(e)=>{
      if(e.key.toLowerCase()==="n") next();
      if(e.key.toLowerCase()==="p") prev();
      if(e.key.toLowerCase()==="r") setTimer( (step?.duration||5) );
    };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  },[step?.duration]);

  /* -------------------------------- render -------------------------------- */
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 lg:px-2 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cook Now</h1>
          <p className="opacity-70">One-tap cooking with smart steps, timers, and pantry-first swaps.</p>
        </div>
        <div className="flex gap-2">
          <Ghost onClick={prefetchQuick}>Refresh picks</Ghost>
          <Primary onClick={startSession} disabled={busy}>{session ? "Restart" : "Start"}</Primary>
        </div>
      </div>

      {banners.map(b=>(
        <Notice key={b.key} tone={b.tone}>
          <div className="flex items-center justify-between w-full">
            <span>{b.text}</span>
            <div className="flex items-center gap-2">
              {b.actions?.map((a,i)=><Subtle key={i} onClick={a.fn}>{a.label}</Subtle>)}
              {b.dismissible!==false && <Ghost onClick={()=>dismissBanner(b.key)}>Dismiss</Ghost>}
            </div>
          </div>
        </Notice>
      ))}

      {/* Quick presets */}
      <Card title="How fast & what’s on hand?" subtitle="Pick a time box, pantry-first toggle, and servings.">
        {loading ? <Skeleton lines={3}/> : (
          <div className="flex flex-wrap gap-3 items-center">
            {demoQuick.map(q => <Pill key={q.id} active={preset?.id===q.id} onClick={()=>setPreset(q)}>{q.label}</Pill>)}
            <label className="label cursor-pointer gap-2 ml-2">
              <span className="label-text">Pantry-first</span>
              <input type="checkbox" className="toggle toggle-primary" checked={pantryFirst} onChange={e=>setPantryFirst(e.target.checked)} />
            </label>
            <div className="flex items-center gap-2">
              <span className="opacity-70">Servings</span>
              <input className="input input-bordered w-24" type="number" value={servings} onChange={(e)=>setServings(Math.max(1,parseInt(e.target.value||"1",10)))} />
            </div>
            <Primary onClick={startSession} disabled={busy}>Start</Primary>
          </div>
        )}
      </Card>

      {/* Guided steps */}
      <Card title="Guided Cooking" subtitle="Hands-free friendly. N = next, P = previous, R = timer.">
        {!session ? (
          <div className="rounded-xl border border-dashed border-base-300 p-6 text-center">
            <p className="font-medium">No active session</p>
            <p className="text-sm opacity-70 mt-1">Choose a quick preset and press Start to begin.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            {/* Current step */}
            <div className="xl:col-span-2">
              <div className="rounded-xl border border-base-200 p-5 bg-base-100">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-lg font-semibold">Step {stepIdx+1} of {session.steps.length}</h4>
                  <div className="flex gap-2">
                    <Subtle onClick={()=>setTimer(step?.duration || 5)}>Set {step?.duration||5}-min timer</Subtle>
                    <Ghost onClick={prev}>Prev</Ghost>
                    <Primary onClick={next}>Next</Primary>
                  </div>
                </div>
                <p className="text-xl">{step?.text}</p>
              </div>

              <div className="mt-3 flex gap-2">
                <Subtle onClick={()=>setToast({tone:"info", text:"Substitutes shown in sidebar (demo)."})}>Suggest substitutes</Subtle>
                <Subtle onClick={openSubs}>Open substitutions</Subtle>
                <Danger onClick={completeSession} disabled={busy}>Finish Session</Danger>
              </div>
            </div>

            {/* Sidebar: prep & timers */}
            <div className="space-y-3">
              <div className="rounded-xl border border-base-200 p-4">
                <p className="font-medium mb-2">Mise en place</p>
                <ul className="list-disc ml-5 text-sm opacity-80 space-y-1">
                  <li>Board + knife</li>
                  <li>Skillet + oil</li>
                  <li>Salt, pepper, spice blend</li>
                </ul>
              </div>
              <div className="rounded-xl border border-base-200 p-4">
                <p className="font-medium mb-2">Active timers</p>
                <p className="text-sm opacity-70">Timers run even if you navigate away; you’ll see a toast on completion.</p>
              </div>
              <div className="rounded-xl border border-base-200 p-4">
                <p className="font-medium mb-2">After you’re done</p>
                <div className="flex flex-col gap-2">
                  <Primary onClick={completeSession} disabled={busy}>Wrap Up & Plan Cleanup</Primary>
                  <Subtle onClick={()=>automation.emit?.("ui.navigate",{to:"/storehouse/leftovers"})}>Create leftover labels</Subtle>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Toast */}
      {toast && (
        <div className="toast toast-end z-50">
          <div className={cx("alert",
              toast.tone==="success"?"alert-success":
              toast.tone==="warning"?"alert-warning":
              toast.tone==="error"?"alert-error":"alert-info")}>
            <div className="flex items-center gap-3">
              <span>{toast.text}</span>
              {toast.action && <button className="btn btn-xs" onClick={()=>toast.action.fn?.()}>{toast.action.label}</button>}
              <button className="btn btn-ghost btn-xs" onClick={()=>setToast(null)}>✕</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
