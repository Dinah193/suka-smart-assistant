# Suka Smart Assistant — Meals Architecture

> **Purpose:** A single, practical map of how the **Meals** domain works end-to-end — from planning to groceries to prep — so you can ship confidently and extend safely.

**File:** `C:\Users\larho\suka-smart-assistant\docs\meals\architecture.md`  
**Last updated:** 2025-10-20

---

## 0) Product goals & UX principles

- **Household-first**: optimize for busy households (clear actions, minimal clicks).
- **Plan → Shop → Prep** in one guided flow with **NBA (Next Best Actions)** rails.
- **Use what you have**: pantry + garden + animal forecasts reduce waste.
- **Respect constraints**: diet, time caps, budget, sabbath guard windows.
- **Great defaults, safe fallbacks**: handlers must succeed even when DI engines are missing.

---

## 1) High-level architecture

```mermaid
flowchart TD
  UI[Web UI\n(Planner/Grocery/Prep)] -->|events| BUS[(Async Event Bus)]
  ORCH[Orchestrators] -->|publish| BUS
  subgraph Planning Engines
    MP[onMealplanDraftRequested]
    GL[onGroceryListRequested]
    PT[onPrepTasksRequested]
    PC[Conflict Scanner/Resolver]
    DC[Decider Scoring]
  end
  BUS --> MP
  BUS --> GL
  BUS --> PT
  BUS --> PC
  PT -->|creates| BS[(Batch Sessions)]
  GL -->|estimates| EE[Estimate Engine]
  GL -->|subs| SUB[Substitution Engine]
  GL -->|aisles| TAX[Aisle Taxonomy]
  DC -->|uses| INV[(Inventory)]
  DC -->|uses| GDN[(Garden)]
  DC -->|uses| ANM[(Animal)]
  MP -->|reads| SCHED[(Schedule Store)]
  GL -->|reads| SCHED
  PT -->|reads| SCHED
