import Image from "next/image";
import type { TravelPhoto } from "@/lib/media/travel-photos";

export function MediaFrame({
  photo,
  label,
  sizes,
  priority = false,
  objectPosition = "center",
  className = "",
}: {
  photo: TravelPhoto | null;
  label: string;
  sizes: string;
  priority?: boolean;
  objectPosition?: string;
  className?: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-frame bg-surface ${className}`}>
      {photo ? (
        <Image
          src={photo.src}
          alt={photo.alt}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
          style={{ objectPosition }}
        />
      ) : (
        <div
          role="img"
          aria-label={`Photograph to come for ${label}`}
          className="flex h-full min-h-24 flex-col justify-between bg-surface-raised p-3"
        >
          <span aria-hidden className="h-2 w-2 rounded-full bg-peach" />
          <span className="text-xs font-semibold tracking-wide text-mist">
            Photograph to come
          </span>
        </div>
      )}
    </div>
  );
}
