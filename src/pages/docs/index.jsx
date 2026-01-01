// inside the top card where you had "Generate Weekly Meal Plan"
<div className="flex gap-2 flex-wrap">
  <button className="btn primary" onClick={async () => { const { id } = await generateSPD("meal-plan-weekly"); setActive(id); }}>
    Generate Weekly Meal Plan
  </button>

  <button className="btn" onClick={async () => { const { id } = await generateSPD("cleaning-rotation"); setActive(id); }}>
    Generate Cleaning Rotation
  </button>

  <button className="btn" onClick={async () => { const { id } = await generateSPD("garden-calendar"); setActive(id); }}>
    Generate Garden Calendar
  </button>

  <button className="btn" onClick={async () => { const { id } = await generateSPD("animal-care-week"); setActive(id); }}>
    Generate Animal Care Week
  </button>
</div>
