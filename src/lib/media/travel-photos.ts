import type { DestinationId, PlaceId } from "@/lib/catalog";

export type TravelPhoto = {
  src: string;
  alt: string;
  width: number;
  height: number;
};

export type EditorialPhoto = TravelPhoto & {
  caption: string;
  /** Display width cap so a small original is not upscaled. */
  maxWidth: number;
};

const seineEiffel = {
  src: "/images/travel/paris-seine-eiffel.jpg",
  alt: "The Eiffel Tower rising beside the Seine, with a bridge and boats on the water.",
  width: 768,
  height: 1024,
} satisfies TravelPhoto;

const maisonRose = {
  src: "/images/travel/montmartre-maison-rose.jpg",
  alt: "La Maison Rose, a pink corner restaurant on a cobbled street in Montmartre.",
  width: 768,
  height: 1024,
} satisfies TravelPhoto;

/**
 * Presentation only. The catalog has no media fields, so this map attaches
 * supplied photographs to approved ids. The founder portrait is not included.
 */
export const placePhotos: Partial<Record<PlaceId, TravelPhoto>> = {
  plc_paris_eiffel_tower: seineEiffel,
  plc_paris_la_maison_rose: maisonRose,
};

export const destinationCovers: Partial<Record<DestinationId, TravelPhoto>> = {
  dst_paris: seineEiffel,
};

export const editorialPhotographs: Partial<Record<DestinationId, readonly EditorialPhoto[]>> = {
  dst_paris: [
    {
      src: "/images/travel/paris-auguste-cafe.jpg",
      alt: "A flower-covered cafe front with the name Auguste above the door.",
      width: 768,
      height: 1024,
      maxWidth: 360,
      caption: "A flower-covered cafe front. This photograph is not one of the listed stops.",
    },
    {
      src: "/images/travel/paris-cafe-breakfast.jpg",
      alt: "A croissant, crepes, and coffee on a sidewalk cafe table.",
      width: 768,
      height: 1024,
      maxWidth: 360,
      caption: "Breakfast at a sidewalk table. This is not one of the listed restaurants.",
    },
    {
      src: "/images/travel/paris-flower-market.jpg",
      alt: "Buckets of colorful flowers at a street stall.",
      width: 360,
      height: 480,
      maxWidth: 360,
      caption: "A flower stall on a Paris street. This is not a listed stop.",
    },
  ],
};
