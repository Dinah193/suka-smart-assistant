// utils/zoneUtils.js

export function getZonePlantingData(zone) {
  const sample = {
    "8a": [
      {
        crop: "Tomatoes",
        start: "Mar 15",
        end: "Apr 10",
        harvestStart: "Jun 10",
        harvestEnd: "Aug 15",
      },
      {
        crop: "Okra",
        start: "Apr 15",
        end: "May 10",
        harvestStart: "Jul 10",
        harvestEnd: "Sep 15",
      },
    ],
    "7b": [
      {
        crop: "Collards",
        start: "Feb 20",
        end: "Mar 15",
        harvestStart: "May 1",
        harvestEnd: "Jun 15",
      },
    ],
  };
  return sample[zone] || [];
}
