import React from "react";

const ANIMAL_EMOJI = Object.freeze({
  sheep: "🐑",
  goats: "🐐",
  cows: "🐄",
  deer: "🦌",
  chickens: "🐔",
  quail: "🪶",
  ducks: "🦆",
  geese: "🪿",
  turkeys: "🦃",
});

const SAFE_ANIMALS = Object.keys(ANIMAL_EMOJI);

function normalizeAnimal(animal) {
  const key = String(animal || "").trim().toLowerCase();
  if (SAFE_ANIMALS.includes(key)) return key;
  return "sheep";
}

export function SSAAnimalAvatar({
  animal = "sheep",
  label,
  size = "md",
  className = "",
}) {
  const kind = normalizeAnimal(animal);
  const tone =
    size === "sm"
      ? "h-8 w-8 text-base"
      : size === "lg"
      ? "h-12 w-12 text-2xl"
      : "h-10 w-10 text-xl";

  return (
    <span
      role="img"
      aria-label={label || kind}
      title={label || kind}
      className={`inline-flex items-center justify-center rounded-full border border-[var(--ssa-border-default)] bg-[var(--ssa-surface-1)] ${tone} ${className}`.trim()}
    >
      {ANIMAL_EMOJI[kind]}
    </span>
  );
}

export const SSAAllowedAnimals = SAFE_ANIMALS;

export default SSAAnimalAvatar;
