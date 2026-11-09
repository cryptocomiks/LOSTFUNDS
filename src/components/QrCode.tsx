import qrcode from "qrcode-generator";

/** A QR code drawn as an SVG at build time (no JavaScript on the page). Dark on white so every scanner reads it, in light and dark mode. */
export function QrCode({ value, size = 128, label }: { value: string; size?: number; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const total = n + quiet * 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      className="shrink-0 rounded-2xl border border-line bg-white"
    >
      <path d={d} fill="#000" />
    </svg>
  );
}
