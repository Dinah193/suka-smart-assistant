export function estimateAnimalOutput({ species = "chicken", count = 0 } = {}) {
  const safeCount = Math.max(0, Number(count || 0));

  if (species === "chicken") {
    return {
      species,
      count: safeCount,
      weeklyEggs: Math.round(safeCount * 4.5),
      preservationReadyOutputs: ["eggs", "stock"],
    };
  }

  return {
    species,
    count: safeCount,
    weeklyEggs: 0,
    preservationReadyOutputs: [],
  };
}

export default { estimateAnimalOutput };
