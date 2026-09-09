import { useId, type SVGProps } from "react";

/** A flat, small-size-safe Möbius ribbon with one explicit overpass. */
export function MobiusLogo({
  size = 32,
  title = "MOBIUS ribbon",
  ...props
}: SVGProps<SVGSVGElement> & { size?: number; title?: string }) {
  const titleId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 48" role="img" aria-labelledby={titleId} {...props}>
      <title id={titleId}>{title}</title>
      <path d="M7 24c7-15 17-15 25 0s18 15 25 0c-7-15-17-15-25 0S14 39 7 24Z" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" opacity=".4" />
      <path d="M7 24c7-15 17-15 25 0s18 15 25 0" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
