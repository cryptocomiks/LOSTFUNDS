/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static site: deploy to IPFS / ENS (.eth.limo), Vercel, Netlify, GitHub Pages…
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
