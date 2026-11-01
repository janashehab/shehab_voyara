import type { Interest } from "@/features/trips/schemas";
import type { RetrievalPlace } from "./retrieve";

const categoryTags: Record<Interest, readonly string[]> = {
  landmarks: ["landmark"],
  walks: ["walk", "neighborhood", "avenue", "canal", "street"],
  museums: ["museum", "art", "gothic", "stained-glass"],
  food: ["dining"],
  shopping: ["shopping", "vintage", "department-store"],
  theme_parks: ["theme-park", "ride", "show"],
  photo_stops: ["photo-stop"],
};

export function placeMatchesInterest(place: RetrievalPlace, interest: Interest): boolean {
  if (interest === "theme_parks" && place.majorDayCommitment) {
    return true;
  }

  const tags = categoryTags[interest];
  return place.vibeTags.some((tag) => tags.includes(tag));
}

export function isIconic(place: RetrievalPlace): boolean {
  return place.vibeTags.includes("landmark") || place.majorDayCommitment;
}
