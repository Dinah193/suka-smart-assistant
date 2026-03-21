import React from "react";

export default function AuthShell({ title, subtitle, children, sidePanel }) {
  return (
    <div
      className="min-h-screen"
      style={{
        background:
          "radial-gradient(1200px 600px at 10% -10%, rgba(79,70,229,0.12), transparent 55%), radial-gradient(1000px 500px at 90% -5%, rgba(16,185,129,0.1), transparent 55%), hsl(var(--background))",
      }}
    >
      <div className="mx-auto w-full max-w-[1120px] px-4 py-8 md:py-12">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(420px,480px)_1fr] md:items-start">
          <section className="card">
            <header className="mb-5">
              <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
              <p className="mt-2 text-sm text-slate-600">{subtitle}</p>
            </header>
            {children}
          </section>

          <aside className="card h-fit">
            {sidePanel}
          </aside>
        </div>
      </div>
    </div>
  );
}
