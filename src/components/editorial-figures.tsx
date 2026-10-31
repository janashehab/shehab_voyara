import Image from "next/image";
import type { EditorialPhoto } from "@/lib/media/travel-photos";

export function EditorialFigures({
  photos,
  placeName,
}: {
  photos: readonly EditorialPhoto[];
  placeName: string;
}) {
  if (photos.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="photographs-heading" className="mx-auto max-w-6xl px-5 py-16">
        <h2 id="photographs-heading" className="font-display text-3xl text-ink">
          Photographs from {placeName}
        </h2>
      <p className="mt-3 max-w-xl text-ink-muted">
        Personal photographs from the city. They are not extra stops, and they
        are not tied to a listed place.
      </p>
      <ul className="mt-8 flex flex-wrap gap-6">
        {photos.map((photo) => (
          <li key={photo.src} className="max-w-full" style={{ width: photo.maxWidth }}>
            <figure>
              <div
                className="relative overflow-hidden rounded-frame"
                style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
              >
                <Image
                  src={photo.src}
                  alt={photo.alt}
                  fill
                  sizes={`${photo.maxWidth}px`}
                  className="object-cover"
                />
              </div>
              <figcaption className="mt-3 text-sm leading-6 text-ink-muted">
                {photo.caption}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}
