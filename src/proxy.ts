import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { approvedDestinationSlugs } from "@/features/destinations/queries";

export function proxy(request: NextRequest) {
  const segment = request.nextUrl.pathname.split("/").filter(Boolean)[1];

  if (!segment) {
    return NextResponse.next();
  }

  const slug = decodeURIComponent(segment);

  if (approvedDestinationSlugs().includes(slug)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/__catalog_miss__";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: "/destinations/:slug",
};
