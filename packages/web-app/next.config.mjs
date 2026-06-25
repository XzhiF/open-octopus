/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@octopus/shared'],
  allowedDevOrigins: ['*.*.*.*', '*.*.*', '*.*'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig