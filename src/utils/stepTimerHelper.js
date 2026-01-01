// src/utils/stepTimerHelper.js
const timeRegex = /(\d+)\s*(minute|min|minutes|seconds|sec|s)/i;
const boilKeywords = ["boil", "simmer", "steam", "reduce"];

export function parseStepWithTimer(instruction) {
  const lower = instruction.toLowerCase();
  const hasTime = instruction.match(timeRegex);
  const keyword = boilKeywords.find((word) => lower.includes(word));

  let timer = null;
  if (hasTime) {
    const value = parseInt(hasTime[1]);
    const unit = hasTime[2].startsWith("s") ? "s" : "m";
    const duration = unit === "s" ? value : value * 60;
    timer = { duration };
  }

  let preStep = null;
  if (keyword && hasTime) {
    preStep = {
      label: "Bring water to a boil",
      duration: 300, // ~5 min
    };
  }

  return { timer, preStep };
}
