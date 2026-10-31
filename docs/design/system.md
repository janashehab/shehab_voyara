# Voyara visual system

Sprint 02. The mobile reference board sets the composition: a full-bleed portrait frame, a pill action, photo cards, and a day timeline. The catalog, data policy, and project rules stay unchanged.

## Color

Midnight `#091B25` is the page. Deep Teal `#123A43` is a raised plate. Ivory `#F6F4EF` is primary text. Mist `#D9F3EB` is for short labels and links. Ocean `#1D7F7A` is a large brand mark. The focus ring is `#3DB8B0`.

Peach `#F4BFA6` is the primary action fill. Midnight text on peach is 10.75:1. Ivory on peach is 1.49:1, so Ivory is not used on peach buttons. Hover fill `#E8B09A` keeps Midnight text. Peach is not used for body copy.

## Type

Fraunces, with the wonk axis at 0, for titles. Source Sans 3 for interface and body. Both load through `next/font`.

## Photography

Supplied files live in `public/images/travel/`. The founder portrait is not in the site.

| File | Use |
|---|---|
| `paris-seine-eiffel.jpg` (768×1024) | Homepage hero, Paris cover, featured card, Eiffel Tower row. Portrait frame, max width 768. |
| `montmartre-maison-rose.jpg` (768×1024) | La Maison Rose row and the Montmartre highlight. |
| `paris-auguste-cafe.jpg` | Editorial photograph. Not a catalog stop. |
| `paris-cafe-breakfast.jpg` | Editorial photograph. Not a listed restaurant. |
| `paris-flower-market.jpg` (360×480) | Editorial photograph, displayed at most 360px wide. |

Missing: a wide desktop hero, and photographs for Disneyland, the Louvre, Notre-Dame, and the other stops. Those rows use a Deep Teal frame labeled “Photograph to come.”

## Routes

`/` introduces Voyara. `/destinations/[slug]` reads approved catalog slugs. Any other slug calls `notFound()`.
