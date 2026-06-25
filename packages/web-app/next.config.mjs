/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['*.*.*.*', '*.*.*', '*.*'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig