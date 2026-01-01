// src/utils/climateUtils.js

/**
 * USDA Zone Mapping by ZIP Code (partial mock, replace with real lookup or API)
 */
const zipToZoneMap = {
  "32210": "9a", // Jacksonville, FL
  "32446": "8b", // Marianna, FL
  "10001": "7b", // NYC
  "30303": "8a", // Atlanta
};

export function getZoneByZip(zip) {
  return zipToZoneMap[zip] || "8a"; // default fallback
}

/**
 * Return climate summary based on zone (monthly averages mock)
 */
export function getClimateSummary(zone) {
  const summaries = {
    "8a": {
      avgLastFrost: "March 20",
      avgFirstFrost: "November 15",
      avgHighs: {
        Jan: 60, Feb: 65, Mar: 72, Apr: 78, May: 85,
        Jun: 90, Jul: 92, Aug: 91, Sep: 88, Oct: 80,
        Nov: 70, Dec: 62,
      },
      rainfallInches: {
        Jan: 4, Feb: 3.5, Mar: 4, Apr: 3.2, May: 4.5,
        Jun: 5.5, Jul: 6, Aug: 5.8, Sep: 4.6, Oct: 3.2,
        Nov: 3.5, Dec: 3.8,
      },
    },
    "9a": {
      avgLastFrost: "Feb 15",
      avgFirstFrost: "Dec 10",
      avgHighs: {
        Jan: 65, Feb: 70, Mar: 76, Apr: 82, May: 88,
        Jun: 92, Jul: 94, Aug: 94, Sep: 90, Oct: 84,
        Nov: 76, Dec: 68,
      },
      rainfallInches: {
        Jan: 3, Feb: 2.8, Mar: 3.6, Apr: 2.5, May: 3.2,
        Jun: 6.3, Jul: 6.7, Aug: 6.5, Sep: 5.2, Oct: 3.0,
        Nov: 2.5, Dec: 2.8,
      },
    },
    // Add more zones as needed
  };

  return summaries[zone] || summaries["8a"];
}

/**
 * Get warnings for planned crops or tasks based on climate risk
 * Example: Warn if planning tomatoes in a frost window
 */
export function getClimateWarnings({ zone, plannedDate, crop }) {
  const climate = getClimateSummary(zone);
  const frostDate = new Date(`${new Date().getFullYear()}-${toMonthNum(climate.avgLastFrost)}`);
  const taskDate = new Date(plannedDate);

  const warnings = [];

  if (["tomato", "pepper", "eggplant"].includes(crop.toLowerCase())) {
    if (taskDate < frostDate) {
      warnings.push("⚠️ Risk: You are planning a warm-season crop before the average last frost.");
    }
  }

  return warnings;
}

/**
 * Utility: convert "March 20" to "03-20"
 */
function toMonthNum(str) {
  const [month, day] = str.split(" ");
  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05",
    Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10",
    Nov: "11", Dec: "12",
  };
  return `${monthMap[month.slice(0, 3)]}-${day.padStart(2, "0")}`;
}
