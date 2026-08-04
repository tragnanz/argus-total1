/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // L'URL del backend è iniettato a build-time via NEXT_PUBLIC_API_BASE.
  eslint: {
    // Lo scaffold non include la config ESLint: non bloccare il build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
